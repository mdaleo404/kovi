local _ = require("gettext")
local DataStorage = require("datastorage")
local LuaSettings = require("luasettings")
local MultiInputDialog = require("ui/widget/multiinputdialog")
local InfoMessage = require("ui/widget/infomessage")
local UIManager = require("ui/uimanager")

local Settings = {}; Settings.__index = Settings
local KEY = "kovi"

local function local_only_url(url)
    local lower = url:lower()
    return lower:match("^https?://localhost[:/]")
        or lower:match("^https?://127%.")
        or lower:match("^https?://0%.0%.0%.0[:/]")
        or lower:match("^https?://%[::1%][:/]")
end

function Settings:new()
    local o=setmetatable({},self); o.handle=LuaSettings:open(DataStorage:getSettingsDir().."/kovi.lua"); o.data=o.handle:readSetting(KEY,{}) or {}; return o
end
function Settings:save() self.handle:saveSetting(KEY,self.data); self.handle:flush() end
function Settings:getServerURL() return (self.data.server_url or ""):gsub("/*$","") end
function Settings:getToken() return self.data.device_token end
function Settings:isPaired() return self:getToken() ~= nil and self:getToken() ~= "" end
function Settings:setToken(v) self.data.device_token=v; self:save() end
function Settings:getSyncOnSuspend() return self.data.sync_on_suspend == true end
function Settings:toggleSyncOnSuspend() self.data.sync_on_suspend=not self:getSyncOnSuspend(); self:save() end

function Settings:showSetup(on_pair)
    local dialog
    dialog = MultiInputDialog:new({
        title = _("kovi setup"),
        fields = {
            { text=self:getServerURL(), description=_("Server URL:"), hint=_("http://192.168.1.10:3000") },
            { text="", description=_("Pairing code:"), hint=_("8-character code") },
        },
        buttons = {{
            { text=_("Cancel"), id="close", callback=function() UIManager:close(dialog) end },
            { text=_("Pair"), callback=function()
                local f=dialog:getFields(); local url=tostring(f[1] or ""):gsub("%s+",""):gsub("/*$",""); local code=tostring(f[2] or ""):upper():gsub("[^A-Z0-9]","")
                if not url:match("^https?://") then UIManager:show(InfoMessage:new({text=_("Server URL must start with http:// or https://")})); return end
                if local_only_url(url) then UIManager:show(InfoMessage:new({text=_("Use the kovi computer's LAN IP, not localhost/127.0.0.1/0.0.0.0. Example: http://192.168.1.23:3000")})); return end
                if #code < 6 then UIManager:show(InfoMessage:new({text=_("Enter the pairing code shown in kovi.")})); return end
                self.data.server_url=url; self:save(); UIManager:close(dialog); on_pair(url,code)
            end },
        }},
    })
    UIManager:show(dialog); dialog:onShowKeyboard()
end
return Settings
