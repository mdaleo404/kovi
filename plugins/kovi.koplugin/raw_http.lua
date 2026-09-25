local socket = require("socket")
local urlmod = require("socket.url")

local M = {}

local function parse_target(target)
    local ok, parsed = pcall(urlmod.parse, target)
    if not ok or type(parsed) ~= "table" then
        return nil, "invalid URL"
    end
    if parsed.scheme ~= "http" then
        return nil, "direct transport only supports http:// URLs"
    end
    if not parsed.host or parsed.host == "" then
        return nil, "URL has no host"
    end
    local port = tonumber(parsed.port) or 80
    if port < 1 or port > 65535 then
        return nil, "invalid port"
    end
    local path = parsed.path
    if not path or path == "" then path = "/" end
    if parsed.params and parsed.params ~= "" then path = path .. ";" .. parsed.params end
    if parsed.query and parsed.query ~= "" then path = path .. "?" .. parsed.query end
    local host_header = parsed.host
    if parsed.host:find(":", 1, true) and parsed.host:sub(1, 1) ~= "[" then
        host_header = "[" .. parsed.host .. "]"
    end
    if port ~= 80 then host_header = host_header .. ":" .. tostring(port) end
    return {
        host = parsed.host,
        port = port,
        path = path,
        host_header = host_header,
    }
end

local function close_quietly(tcp)
    if tcp then pcall(function() tcp:close() end) end
end

function M.probe(target, timeout)
    local parsed, parse_err = parse_target(target)
    if not parsed then
        return false, { stage = "url", detail = parse_err }
    end
    local tcp, socket_err = socket.tcp()
    if not tcp then
        return false, { stage = "socket", detail = tostring(socket_err or "cannot create TCP socket") }
    end
    tcp:settimeout(timeout or 6)
    local connected, connect_err = tcp:connect(parsed.host, parsed.port)
    close_quietly(tcp)
    if not connected then
        return false, {
            stage = "tcp",
            detail = tostring(connect_err or "connection failed"),
            host = parsed.host,
            port = parsed.port,
        }
    end
    return true, { host = parsed.host, port = parsed.port }
end

local function decode_chunked(body)
    local out = {}
    local pos = 1
    while true do
        local line_end = body:find("\r\n", pos, true)
        if not line_end then return nil, "invalid chunked response" end
        local size_line = body:sub(pos, line_end - 1):match("^%s*([^;]+)")
        local size = tonumber(size_line, 16)
        if not size then return nil, "invalid chunk size" end
        pos = line_end + 2
        if size == 0 then return table.concat(out) end
        local chunk_end = pos + size - 1
        if chunk_end > #body then return nil, "truncated chunked response" end
        out[#out + 1] = body:sub(pos, chunk_end)
        pos = chunk_end + 1
        if body:sub(pos, pos + 1) ~= "\r\n" then return nil, "invalid chunk separator" end
        pos = pos + 2
    end
end

function M.request(method, target, headers, body, timeout)
    local parsed, parse_err = parse_target(target)
    if not parsed then
        return nil, nil, nil, nil, { stage = "url", detail = parse_err }
    end

    local tcp, socket_err = socket.tcp()
    if not tcp then
        return nil, nil, nil, nil, { stage = "socket", detail = tostring(socket_err or "cannot create TCP socket") }
    end
    tcp:settimeout(timeout or 12)
    local connected, connect_err = tcp:connect(parsed.host, parsed.port)
    if not connected then
        close_quietly(tcp)
        return nil, nil, nil, nil, {
            stage = "tcp",
            detail = tostring(connect_err or "connection failed"),
            host = parsed.host,
            port = parsed.port,
        }
    end

    headers = headers or {}
    local has_host, has_connection, has_length = false, false, false
    local lines = { tostring(method or "GET") .. " " .. parsed.path .. " HTTP/1.1" }
    for k, v in pairs(headers) do
        local lower = tostring(k):lower()
        if lower == "host" then has_host = true end
        if lower == "connection" then has_connection = true end
        if lower == "content-length" then has_length = true end
        lines[#lines + 1] = tostring(k) .. ": " .. tostring(v)
    end
    if not has_host then lines[#lines + 1] = "Host: " .. parsed.host_header end
    if not has_connection then lines[#lines + 1] = "Connection: close" end
    if body ~= nil and not has_length then lines[#lines + 1] = "Content-Length: " .. tostring(#body) end
    lines[#lines + 1] = ""
    lines[#lines + 1] = ""
    local payload = table.concat(lines, "\r\n") .. (body or "")

    local sent, send_err, sent_partial = tcp:send(payload)
    if not sent then
        close_quietly(tcp)
        return nil, nil, nil, nil, {
            stage = "send",
            detail = tostring(send_err or "send failed") .. (sent_partial and (" after " .. tostring(sent_partial) .. " bytes") or ""),
        }
    end

    local chunks = {}
    while true do
        local chunk, receive_err, partial = tcp:receive(4096)
        if chunk and #chunk > 0 then chunks[#chunks + 1] = chunk end
        if partial and #partial > 0 then chunks[#chunks + 1] = partial end
        if receive_err then
            if receive_err ~= "closed" then
                close_quietly(tcp)
                return nil, nil, nil, nil, { stage = "receive", detail = tostring(receive_err) }
            end
            break
        end
    end
    close_quietly(tcp)

    local raw = table.concat(chunks)
    local header_block, response_body = raw:match("^(.-)\r\n\r\n(.*)$")
    if not header_block then
        return nil, nil, nil, nil, { stage = "http", detail = "malformed HTTP response" }
    end
    local status_line, rest = header_block:match("^([^\r\n]+)\r\n(.*)$")
    if not status_line then status_line, rest = header_block, "" end
    local code = tonumber(status_line:match("^HTTP/%d+%.%d+%s+(%d%d%d)"))
    if not code then
        return nil, nil, nil, nil, { stage = "http", detail = "invalid status line: " .. tostring(status_line) }
    end

    local response_headers = {}
    for line in (rest .. "\r\n"):gmatch("(.-)\r\n") do
        local key, value = line:match("^([^:]+):%s*(.*)$")
        if key then response_headers[key:lower()] = value end
    end
    if response_headers["transfer-encoding"] and response_headers["transfer-encoding"]:lower():find("chunked", 1, true) then
        local decoded, chunk_err = decode_chunked(response_body)
        if not decoded then
            return nil, nil, nil, nil, { stage = "http", detail = chunk_err }
        end
        response_body = decoded
    end

    return code, response_headers, status_line, response_body, nil
end

return M
