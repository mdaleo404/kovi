local _ = require("gettext")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local UIManager = require("ui/uimanager")
local InfoMessage = require("ui/widget/infomessage")
local NetworkMgr = require("ui/network/manager")
local Settings = require("settings")
local Upload = require("upload")
local const = require("./const")

local kovi = WidgetContainer:extend({ name="kovi", is_doc_only=false })
function kovi:init() self.ui.menu:registerToMainMenu(self); self.settings=Settings:new() end

function kovi:showMessage(text) UIManager:show(InfoMessage:new({text=_(text),timeout=4})) end
function kovi:pair()
    self.settings:showSetup(function(url,code)
        NetworkMgr:runWhenOnline(function()
            local ok,response=Upload.pair(url,code,self.settings)
            if ok then self:showMessage("kovi paired successfully.") else self:showMessage("Pairing failed: "..tostring(response and response.error or "unknown error")) end
        end)
    end)
end
function kovi:sync(silent)
    local url=self.settings:getServerURL(); local token=self.settings:getToken()
    if url=="" or not token then if not silent then self:showMessage("Pair this reader with kovi first.") end; return end
    NetworkMgr:runWhenOnline(function()
        local ok,response=Upload.sync(url,token)
        if not silent then
            if ok then self:showMessage(response and response.message or "kovi sync complete.")
            else self:showMessage("Sync failed: "..tostring(response and response.error or "server error")) end
        end
    end)
end

function kovi:testConnection()
    local url=self.settings:getServerURL()
    if url=="" then self:showMessage("Configure the kovi server URL first."); return end
    NetworkMgr:runWhenOnline(function()
        local ok,response=Upload.diagnose(url)
        if ok then
            self:showMessage("kovi connection OK"..(response and response.version and (" · v"..tostring(response.version)) or "."))
        else
            self:showMessage("Connection test failed: "..tostring(response and response.error or "unknown error"))
        end
    end)
end

function kovi:onSuspend() if self.settings:getSyncOnSuspend() then self:sync(true) end end
function kovi:onPowerOff() if self.settings:getSyncOnSuspend() then self:sync(true) end end
function kovi:addToMainMenu(menu_items)
    menu_items.kovi={text=_("kovi"),sorting_hint="tools",sub_item_table={
        {text=_("Sync now"),callback=function() self:sync(false) end,separator=true},
        {text=_("Pair / change server"),callback=function() self:pair() end},
        {text=_("Test server connection"),callback=function() self:testConnection() end},
        {text=_("Sync on suspend"),checked_func=function() return self.settings:getSyncOnSuspend() end,callback=function() self.settings:toggleSyncOnSuspend() end},
        {text=_("About kovi"),callback=function() self:showMessage("kovi secure sync plugin · v"..const.VERSION) end},
    }}
end
return kovi
