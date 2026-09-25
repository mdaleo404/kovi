local socketutil = require("socketutil")
local ltn12 = require("ltn12")
local logger = require("logger")
local socket = require("socket")
local http = require("socket.http")
local JSON = require("json")
local RawHttp = require("raw_http")
local const = require("./const")

local function decode_json(content)
    if not content or content == "" then return {} end
    local ok, decoded = pcall(JSON.decode, content)
    if ok and decoded then return decoded end
    return nil
end

local function format_network_error(detail, stage, host, port)
    detail = tostring(detail or "network unreachable")
    local where = ""
    if host and port then where = " to " .. tostring(host) .. ":" .. tostring(port) end
    local hint = " Check the server URL and Wi-Fi."
    if stage == "tcp" then
        hint = " kovi is not reachable on that TCP port from the reader. Check the host firewall and that both devices are on the same LAN."
    elseif stage == "url" then
        hint = " Check the server URL."
    end
    return false, {
        error = "kovi " .. tostring(stage or "network") .. " error" .. where .. ": " .. detail .. "." .. hint,
        kind = "network",
        stage = stage,
        detail = detail,
    }
end

local function interpret(code, resp_headers, status, content)
    local parsed = decode_json(content)
    local numeric_code = tonumber(code)
    if numeric_code and numeric_code >= 200 and numeric_code < 300 then
        if parsed then return true, parsed end
        return false, { error = "kovi returned a successful response that was not valid JSON.", kind = "response" }
    end
    logger.err("[kovi] HTTP error", code, status, content)
    if parsed and parsed.error then return false, parsed end
    return false, {
        error = "kovi returned HTTP " .. tostring(code) .. (status and (" (" .. tostring(status) .. ")") or ""),
        kind = "http",
        status = numeric_code,
    }
end

local function koreader_http(method, target, headers, body)
    local sink = {}
    local request = {
        method = method,
        url = target,
        headers = headers,
        sink = ltn12.sink.table(sink),
        redirect = false,
    }
    if body ~= nil then request.source = ltn12.source.string(body) end

    socketutil:set_timeout(socketutil.LARGE_BLOCK_TIMEOUT, socketutil.LARGE_TOTAL_TIMEOUT)
    local ok, code, resp_headers, status = pcall(function()
        return socket.skip(1, http.request(request))
    end)
    socketutil:reset_timeout()
    if not ok then
        return nil, nil, nil, nil, { stage = "http", detail = tostring(code) }
    end
    if resp_headers == nil then
        return nil, nil, nil, nil, { stage = "http", detail = tostring(status or code or "network unreachable") }
    end
    return code, resp_headers, status, table.concat(sink), nil
end

return function(method, target, headers, body)
    headers = headers or {}
    headers["Accept"] = headers["Accept"] or "application/json"
    headers["Accept-Encoding"] = "identity"
    headers["User-Agent"] = "kovi-KOReader/" .. tostring(const.VERSION)

    logger.dbg("[kovi] API", method, target)

    -- LAN pairing is normally plain HTTP. Use a minimal direct TCP HTTP client first;
    -- this avoids platform-specific LuaSocket HTTP quirks and gives useful TCP errors.
    if target:match("^http://") then
        local code, resp_headers, status, content, raw_err = RawHttp.request(method, target, headers, body, 12)
        if code then return interpret(code, resp_headers, status, content) end
        logger.warn("[kovi] direct HTTP failed", raw_err and raw_err.stage, raw_err and raw_err.detail)

        -- Fall back to KOReader's standard HTTP stack, matching built-in plugins.
        local f_code, f_headers, f_status, f_content, fallback_err = koreader_http(method, target, headers, body)
        if f_code then return interpret(f_code, f_headers, f_status, f_content) end
        local best = raw_err or fallback_err or { stage = "network", detail = "network unreachable" }
        return format_network_error(best.detail, best.stage, best.host, best.port)
    end

    -- KOReader's bundled socket.http is used by built-in plugins for HTTPS URLs.
    local code, resp_headers, status, content, err = koreader_http(method, target, headers, body)
    if not code then return format_network_error(err and err.detail, err and err.stage) end
    return interpret(code, resp_headers, status, content)
end
