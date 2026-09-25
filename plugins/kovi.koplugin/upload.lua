local JSON = require("json")
local Device = require("device")
local random = require("random")
local logger = require("logger")
local callApi = require("call_api")
local RawHttp = require("raw_http")
local Db = require("db_reader")
local Annotations = require("annotation_reader")
local Covers = require("cover_reader")
local const = require("./const")
local U = {}

local function headers(body, token, content_type)
    local h = { ["Content-Type"] = content_type or "application/json" }
    if body ~= nil then h["Content-Length"] = tostring(#body) end
    if token and token ~= "" then h["Authorization"] = "Bearer " .. token end
    return h
end

local function device_id()
    local id = G_reader_settings:readSetting("device_id")
    if id == nil or id == "" then
        id = random.uuid()
        G_reader_settings:saveSetting("device_id", id)
        if G_reader_settings.flush then G_reader_settings:flush() end
    end
    return id
end

function U.ping(server_url)
    return callApi("GET", server_url .. "/api/plugin/ping", { ["Accept"] = "application/json" }, nil)
end

function U.diagnose(server_url)
    if server_url:match("^http://") then
        local tcp_ok, tcp_info = RawHttp.probe(server_url .. "/api/plugin/ping", 6)
        if not tcp_ok then
            local host_port = ""
            if tcp_info and tcp_info.host and tcp_info.port then
                host_port = " " .. tostring(tcp_info.host) .. ":" .. tostring(tcp_info.port)
            end
            return false, {
                error = "TCP connection to" .. host_port .. " failed: " .. tostring(tcp_info and tcp_info.detail or "unknown error") .. ". If kovi works on the computer itself, allow inbound TCP port 3000 (or your configured port) in the computer's firewall and make sure the reader is on the same LAN.",
                stage = tcp_info and tcp_info.stage or "tcp",
            }
        end
    end
    local ok, response = U.ping(server_url)
    if not ok then return false, response end
    return true, {
        version = response and response.version,
        message = "TCP and HTTP checks passed.",
    }
end

function U.pair(server_url, code, settings)
    local reachable, diagnostic = U.diagnose(server_url)
    if not reachable then return false, diagnostic end

    local body = JSON.encode({
        code = code,
        device_id = device_id(),
        model = Device.model,
        version = const.VERSION,
    })
    local ok, response = callApi("POST", server_url .. "/api/plugin/pair", headers(body, nil), body)
    if ok and response and response.token then
        settings:setToken(response.token)
        -- Pairing represents a fresh server-side sync identity. Reset incremental
        -- cursors so a rebuilt kovi database receives a complete first sync.
        G_reader_settings:saveSetting("kovi_sync_cursor", 0)
        G_reader_settings:saveSetting("kovi_annotation_versions", {})
        G_reader_settings:saveSetting("kovi_completion_sync_version", 0)
        if G_reader_settings.flush then G_reader_settings:flush() end
        return true, response
    end
    return false, response
end

function U.sync(server_url, token)
    local cursor = tonumber(G_reader_settings:readSetting("kovi_sync_cursor")) or 0
    local previous_versions = G_reader_settings:readSetting("kovi_annotation_versions") or {}
    local needs_completion_scan = G_reader_settings:readSetting("kovi_completion_sync_version") ~= 1
    if needs_completion_scan then previous_versions = {} end
    local books = Db.bookData()
    local stats = Db.progressData(cursor, books)
    local annotation_sets, annotation_versions = Annotations.changed(previous_versions)
    local body = JSON.encode({
        books = books, stats = stats, annotation_sets = annotation_sets,
        sync_cursor = cursor, version = const.VERSION
    })
    local ok, response = callApi("POST", server_url .. "/api/plugin/import", headers(body, token), body)
    if not ok then return false, response end

    -- Advance only after the server committed the import. If a request fails, the
    -- same overlap/change set is retried on the next manual sync.
    if response and response.sync_cursor then
        G_reader_settings:saveSetting("kovi_sync_cursor", tonumber(response.sync_cursor) or cursor)
    end
    G_reader_settings:saveSetting("kovi_annotation_versions", annotation_versions)
    G_reader_settings:saveSetting("kovi_completion_sync_version", 1)
    if G_reader_settings.flush then G_reader_settings:flush() end

    local requests = response and response.cover_requests
    local uploaded = 0
    if type(requests) == "table" and #requests > 0 then
        local covers = Covers.extractRequested(requests)
        for _, cover in ipairs(covers) do
            local cover_headers = headers(cover.data, token, "image/jpeg")
            cover_headers["X-Kovi-Book-MD5"] = cover.book_md5
            local cover_ok, cover_response = callApi("POST", server_url .. "/api/plugin/cover", cover_headers, cover.data)
            if cover_ok then
                uploaded = uploaded + 1
            else
                local detail = cover_response and cover_response.error or "server rejected cover"
                logger.warn("[kovi] Embedded cover upload failed", cover.book_md5, tostring(detail))
            end
        end
    end
    if response then
        response.embedded_covers = uploaded
        if uploaded > 0 then
            response.message = tostring(response.message or "kovi sync complete.") .. " Uploaded " .. tostring(uploaded) .. " embedded cover" .. (uploaded == 1 and "." or "s.")
        end
    end
    return true, response
end
return U
