local SQ3 = require("lua-ljsqlite3/init")
local DataStorage = require("datastorage")
local logger = require("logger")
local db_location = DataStorage:getSettingsDir() .. "/statistics.sqlite3"
local Reader = {}
local OVERLAP_SECONDS = 24 * 60 * 60

function Reader.bookData()
    local conn = SQ3.open(db_location)
    local sql = "SELECT id,title,authors,notes,last_open,highlights,pages,series,language,md5,total_read_time,total_read_pages FROM book"
    local result, rows = conn:exec(sql)
    local books = {}
    for i = 1, rows do
        table.insert(books, {
            id = tonumber(result[1][i]), title = result[2][i], authors = result[3][i],
            notes = tonumber(result[4][i]), last_open = tonumber(result[5][i]), highlights = tonumber(result[6][i]),
            pages = tonumber(result[7][i]), series = result[8][i], language = result[9][i], md5 = result[10][i],
            total_read_time = tonumber(result[11][i]), total_read_pages = tonumber(result[12][i]),
        })
    end
    conn:close()
    return books
end

local function md5_by_id(books)
    local map = {}
    for _, b in ipairs(books) do map[b.id] = b.md5 end
    return map
end

local function flush_statistics()
    local ok, ReaderUI = pcall(require, "apps/reader/readerui")
    if ok and ReaderUI and ReaderUI.instance and ReaderUI.instance.statistics and ReaderUI.instance.statistics.is_doc then
        pcall(function() ReaderUI.instance.statistics:insertDB() end)
    end
end

-- The first sync sends the complete statistics history. Successful syncs store a
-- high-water mark on the reader; later syncs only re-send a one-day overlap.
-- kovi de-duplicates identical page_stat_data events, so the overlap protects
-- against clock/order edge cases without double-counting reading time.
function Reader.progressData(sync_cursor, books)
    flush_statistics()
    books = books or Reader.bookData()
    local map = md5_by_id(books)
    local cursor = math.max(0, tonumber(sync_cursor) or 0)
    local threshold = math.max(0, cursor - OVERLAP_SECONDS)
    local conn = SQ3.open(db_location)
    local sql = "SELECT id_book,page,start_time,duration,total_pages FROM page_stat_data"
    if threshold > 0 then sql = sql .. " WHERE start_time >= " .. tostring(math.floor(threshold)) end
    local result, rows = conn:exec(sql)
    local stats = {}
    local device_id = G_reader_settings:readSetting("device_id")
    for i = 1, rows do
        local md5 = map[tonumber(result[1][i])]
        if md5 then
            table.insert(stats, {
                book_md5 = md5, page = tonumber(result[2][i]), start_time = tonumber(result[3][i]),
                duration = tonumber(result[4][i]), total_pages = tonumber(result[5][i]), device_id = device_id,
            })
        else
            logger.warn("[kovi] statistic row references unknown book")
        end
    end
    conn:close()
    return stats
end
return Reader
