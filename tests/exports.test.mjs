import test from 'node:test';
import assert from 'node:assert/strict';
import { sendBooksCsv } from '../lib/exports.mjs';

function captureResponse(){
  return {status:null,headers:null,chunks:[],writeHead(status,headers){this.status=status;this.headers=headers},write(chunk){this.chunks.push(String(chunk));return true},end(chunk=''){if(chunk)this.chunks.push(String(chunk))},body(){return this.chunks.join('')}};
}

test('books CSV exports readable durations and UTC dates instead of raw seconds/timestamps',()=>{
  const rows=[{title:'The Hobbit',authors:'J.R.R. Tolkien',series:null,language:'eng',isbn:'9780000000000',total_read_time:5000,total_read_pages:80,highlights:2,last_open:1700000000,cover_source:'manual-upload',pages:310,last_page:164,last_total_pages:310,koreader_status:'complete',read_override:null}];
  const db={prepare(){return {iterate(){return rows}}}};
  const res=captureResponse();sendBooksCsv(res,db);
  assert.equal(res.status,200);assert.match(res.headers['Content-Type'],/text\/csv/);
  const body=res.body();
  assert.match(body,/status,document_progress,reading_time/);assert.match(body,/,read,53%,/);assert.match(body,/last_opened/);assert.match(body,/1h 23m 20s/);assert.match(body,/2023-11-14 22:13:20 UTC/);
  assert.doesNotMatch(body,/reading_seconds/);assert.doesNotMatch(body,/,5000,/);assert.doesNotMatch(body,/,1700000000,/);
});

test('books CSV leaves an unknown last-opened date blank',()=>{
  const rows=[{title:'Unread',authors:'',series:'',language:'',isbn:'',total_read_time:0,total_read_pages:0,highlights:0,last_open:0,cover_source:null}];
  const db={prepare(){return {iterate(){return rows}}}};
  const res=captureResponse();sendBooksCsv(res,db);
  assert.match(res.body(),/Unread,,,,,unread,0%,0s,0,0,,/);
});
