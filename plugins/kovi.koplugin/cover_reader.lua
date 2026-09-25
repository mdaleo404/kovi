local DocSettings = require("docsettings")
local FileManagerBookInfo = require("apps/filemanager/filemanagerbookinfo")
local DataStorage = require("datastorage")
local random = require("random")
local logger = require("logger")
local lfs = require("libs/libkoreader-lfs")

local Reader = {}
local MAX_BYTES = 4 * 1024 * 1024

local function sidecar_md5(file_path)
    if not file_path then return nil end
    local sidecar = DocSettings:findSidecarFile(file_path)
    if not sidecar then return nil end
    local settings = DocSettings.openSettingsFile(sidecar)
    return settings:readSetting("partial_md5_checksum")
end

local function paths_for(md5s)
    local wanted, remaining = {}, 0
    for _, md5 in ipairs(md5s or {}) do
        if md5 and md5 ~= "" and not wanted[md5] then
            wanted[md5] = false
            remaining = remaining + 1
        end
    end
    if remaining == 0 then return wanted end

    local ok, ReadHistory = pcall(require, "readhistory")
    if not ok or not ReadHistory or type(ReadHistory.hist) ~= "table" then
        logger.warn("[kovi] Could not read KOReader history for embedded covers")
        return wanted
    end

    for _, entry in ipairs(ReadHistory.hist) do
        if remaining == 0 then break end
        if entry.file and not entry.dim then
            local success, md5 = pcall(sidecar_md5, entry.file)
            if success and md5 and wanted[md5] == false then
                wanted[md5] = entry.file
                remaining = remaining - 1
            end
        end
    end
    return wanted
end

local function read_all(file_path)
    local f, err = io.open(file_path, "rb")
    if not f then return nil, tostring(err or "cannot open temporary cover") end
    local data = f:read("*all")
    f:close()
    if not data or data == "" then return nil, "temporary cover is empty" end
    if #data > MAX_BYTES then return nil, "embedded cover is larger than 4 MB" end
    return data
end

local function extract_jpeg(file_path)
    local cover = FileManagerBookInfo:getCoverImage(nil, file_path)
    if not cover then return nil, "book has no extractable embedded cover" end

    local cache_dir = DataStorage:getDataDir() .. "/cache/"
    lfs.mkdir(cache_dir)
    local tmp = cache_dir .. "kovi-cover-" .. random.uuid() .. ".jpg"
    local ok = cover:writeToFile(tmp, "jpg", 82, false)
    cover:free()
    if not ok then
        os.remove(tmp)
        return nil, "KOReader could not encode the cover as JPEG"
    end
    local data, err = read_all(tmp)
    os.remove(tmp)
    return data, err
end

function Reader.extractRequested(md5s)
    local paths = paths_for(md5s)
    local out = {}
    for _, md5 in ipairs(md5s or {}) do
        local file_path = paths[md5]
        if file_path then
            local ok, data, err = pcall(extract_jpeg, file_path)
            if ok and data then
                table.insert(out, { book_md5 = md5, data = data })
                logger.info("[kovi] Extracted embedded cover", md5, #data, "bytes")
            else
                logger.warn("[kovi] Embedded cover extraction failed", md5, tostring(ok and err or data))
            end
        else
            logger.info("[kovi] No local file found for requested cover", md5)
        end
    end
    return out
end

return Reader
