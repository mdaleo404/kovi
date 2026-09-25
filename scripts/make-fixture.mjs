import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const out=path.resolve(process.argv[2]||'tests/fixture-statistics.sqlite3');fs.rmSync(out,{force:true});fs.mkdirSync(path.dirname(out),{recursive:true});
const db=new DatabaseSync(out);
db.exec(`
CREATE TABLE book (id INTEGER PRIMARY KEY,title TEXT,authors TEXT,notes INTEGER,last_open INTEGER,highlights INTEGER,pages INTEGER,series TEXT,language TEXT,md5 TEXT,total_read_time INTEGER,total_read_pages INTEGER);
CREATE TABLE page_stat_data (id_book INTEGER,page INTEGER,start_time INTEGER,duration INTEGER,total_pages INTEGER);
`);
const now=Math.floor(Date.now()/1000);
const ins=db.prepare(`INSERT INTO book VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
ins.run(1,'The Left Hand of Darkness','Ursula K. Le Guin',2,now-3600,5,304,'Hainish Cycle','eng','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',18000,156);
ins.run(2,'The Hobbit','J.R.R. Tolkien',1,now-86400,3,310,null,'eng','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',9200,91);
const st=db.prepare(`INSERT INTO page_stat_data VALUES(?,?,?,?,?)`);
st.run(1,150,now-7200,1800,304);st.run(1,156,now-3600,2100,304);st.run(2,91,now-86400,1200,310);
db.close();console.log(out);
