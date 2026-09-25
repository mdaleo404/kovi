local DocSettings = require("docsettings")
local logger = require("logger")
local lfs_ok, lfs = pcall(require, "lfs")
local Reader = {}

local function live_ui()
    local ok, ReaderUI = pcall(require, "apps/reader/readerui")
    if ok and ReaderUI then return ReaderUI.instance end
    return nil
end

local function sidecar_for(file_path)
    if not file_path then return nil end
    return DocSettings:findSidecarFile(file_path)
end

local function sidecar_signature(sidecar)
    if not lfs_ok or not sidecar then return nil end
    local attrs = lfs.attributes(sidecar)
    if not attrs then return nil end
    return tostring(attrs.modification or 0) .. ":" .. tostring(attrs.size or 0)
end

local function clean_annotation(annotation, total_pages, legacy)
    if type(annotation) ~= "table" then return nil end
    local text = annotation.text
    if (not text or text == "") and legacy then text = annotation.notes end
    local kind = "bookmark"
    if annotation.note and annotation.note ~= "" then kind = "note"
    elseif text and text ~= "" then kind = "highlight"
    elseif annotation.drawer or annotation.highlighted then kind = "highlight" end
    return {
        datetime = annotation.datetime,
        datetime_updated = annotation.datetime_updated,
        drawer = annotation.drawer,
        color = annotation.color,
        text = text,
        note = annotation.note,
        chapter = annotation.chapter,
        pageno = annotation.pageno,
        page = ((type(annotation.page) == "string" or type(annotation.page) == "number") and annotation.page) or nil,
        total_pages = total_pages,
        annotation_type = kind,
    }
end

local function read_set(sidecar)
    if not sidecar then return nil end
    local settings = DocSettings.openSettingsFile(sidecar)
    local md5 = settings:readSetting("partial_md5_checksum")
    if not md5 or md5 == "" then return nil end
    local total_pages = settings:readSetting("doc_pages")
    local props = settings:readSetting("doc_props") or {}
    local summary = settings:readSetting("summary") or {}
    local annotations = settings:readSetting("annotations")
    local legacy = false
    if type(annotations) ~= "table" then
        annotations = settings:readSetting("bookmarks")
        legacy = true
    end
    if type(annotations) ~= "table" then annotations = {} end
    local cleaned = {}
    for _, annotation in ipairs(annotations) do
        local item = clean_annotation(annotation, total_pages, legacy)
        if item then table.insert(cleaned, item) end
    end
    return { book_md5 = md5, identifiers = props.identifiers, reading_status = summary.status, reading_status_modified = summary.modified, annotations = cleaned }
end

-- Scanning history is cheap; opening every sidecar is not. Persist each sidecar's
-- mtime/size signature and only parse/transmit books whose sidecar changed.
function Reader.changed(previous_versions)
    local ui = live_ui()
    if ui and ui.doc_settings then pcall(function() ui.doc_settings:flush() end) end
    previous_versions = type(previous_versions) == "table" and previous_versions or {}

    local ok, ReadHistory = pcall(require, "readhistory")
    if not ok or not ReadHistory or type(ReadHistory.hist) ~= "table" then
        logger.warn("[kovi] Could not read KOReader history for annotation sync")
        return {}, previous_versions
    end

    local sets, versions, seen_md5, present_md5, current_paths = {}, {}, {}, {}, {}
    local scanned, opened, unchanged, errors = 0, 0, 0, 0
    for _, entry in ipairs(ReadHistory.hist) do
        if entry.file and not entry.dim then
            scanned = scanned + 1
            local sidecar = sidecar_for(entry.file)
            if sidecar then
                current_paths[entry.file] = true
                local signature = sidecar_signature(sidecar)
                local previous = previous_versions[entry.file]
                local previous_signature = type(previous) == "table" and previous.signature or previous
                local previous_md5 = type(previous) == "table" and previous.book_md5 or nil
                if signature and previous_signature == signature and previous_md5 then
                    versions[entry.file] = { signature = signature, book_md5 = previous_md5 }
                    present_md5[previous_md5] = true
                    unchanged = unchanged + 1
                else
                    local success, set = pcall(read_set, sidecar)
                    if success and set then
                        present_md5[set.book_md5] = true
                        if not seen_md5[set.book_md5] then
                            seen_md5[set.book_md5] = true
                            table.insert(sets, set)
                        end
                        if signature then versions[entry.file] = { signature = signature, book_md5 = set.book_md5 } end
                        opened = opened + 1
                    elseif not success then
                        errors = errors + 1
                        logger.warn("[kovi] Failed reading annotation sidecar", entry.file)
                    end
                end
            end
        end
    end

    -- If a previously synced sidecar disappeared, send an empty set once so the
    -- server can remove annotations that no longer exist on this reader.
    for file_path, previous in pairs(previous_versions) do
        if not current_paths[file_path] and type(previous) == "table" and previous.book_md5 and not present_md5[previous.book_md5] and not seen_md5[previous.book_md5] then
            table.insert(sets, { book_md5 = previous.book_md5, annotations = {} })
            seen_md5[previous.book_md5] = true
        end
    end

    logger.info("[kovi] Incremental annotation scan", scanned, "history entries,", opened, "changed sidecars,", unchanged, "unchanged,", errors, "errors")
    return sets, versions
end

function Reader.all()
    return Reader.changed({})
end

return Reader
