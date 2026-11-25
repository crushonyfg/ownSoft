import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { NotebookStore } from "./store.mjs";
import { Profiles } from "./profiles.mjs";
import { exportTestbed, prepareTestbed } from "./portable-data.mjs";

test("portable testbed retains notebook relationships, drafts and PDFs without native account or path state", () => {
  const root = mkdtempSync(join(tmpdir(), "ownsoft-portable-test-"));
  const source = join(root, "source"), target = join(root, "target"), archive = join(root, "fixture.zip");
  mkdirSync(source);
  const store = new NotebookStore(join(source, "notebook.sqlite"));
  try {
    const profiles = new Profiles(store.db);
    const settings = profiles.read();
    settings.profiles.push({id:"private-account",provider:"gpt",name:"private login",token:"do-not-export-account-config"});
    store.db.prepare("UPDATE model_settings SET data=? WHERE id=1").run(JSON.stringify(settings));
    const doc = store.read();
    doc.workDir = "C:/old-machine/private-project";
    doc.modelSessions = {gpt:{id:"private-native-session"}};
    doc.members = [{id:"gpt1",profileId:"private-account",name:"GPT"}];
    store.write(doc);
    store.saveReply(null, "保留问题", "保留回答");
    const md = store.saveMdDocument(randomUUID(),{name:"example.md",path:"C:/old-machine/example.md",text:"原文内容",comments:[],marks:[],fileText:"原文",fileHash:"old",unsynced:true});
    const selection = store.openChildChat({kind:"md-selection",mdId:md.id,selection:{id:"selection",start:0,quote:"原文",paragraph:"原文内容"}});
    mkdirSync(join(source, "reviews"));
    writeFileSync(join(source,"reviews","example.pdf"), "%PDF-saved-review");
    mkdirSync(join(source,"profiles"));
    writeFileSync(join(source,"profiles","auth.json"), "private-auth-token");
    const summary = exportTestbed(source, archive);
    assert.equal(summary.markdownDocuments, 1);
    assert.equal(summary.childChats, 1);
    const entries = unzipSync(readFileSync(archive));
    assert.ok(entries["reviews/example.pdf"]);
    assert.ok(!Object.keys(entries).some(name => name.startsWith("profiles/")));
    const bytes = Buffer.from(entries["notebook.sqlite"]);
    for (const secret of ["private-auth-token","do-not-export-account-config","private-native-session","C:/old-machine"])
      assert.equal(bytes.includes(Buffer.from(secret)),false);
    prepareTestbed(archive,target);
    const restored = new NotebookStore(join(target,"notebook.sqlite"));
    try {
      assert.equal(restored.read(doc.id).workDir,undefined);
      assert.equal(restored.read(doc.id).members[0].profileId,"gpt-native");
      assert.equal(restored.read(doc.id).modelSessions,undefined);
      assert.equal(restored.mdDocument(md.id).path,"");
      assert.equal(restored.mdDocument(md.id).text,"原文内容");
      assert.equal(restored.read(selection).parent.mdId,md.id);
      assert.equal(new Profiles(restored.db).read().profiles.some(x=>x.id==="private-account"),false);
      assert.ok(existsSync(join(target,"reviews","example.pdf")));
      assert.throws(()=>prepareTestbed(archive,target),/已有笔记数据库/);
    } finally {restored.close();}
    assert.equal(store.read(doc.id).workDir,"C:/old-machine/private-project");
    assert.equal(store.mdDocument(md.id).path,"C:/old-machine/example.md");
  } finally {store.close();}
});

test("portable export stops when notebook content contains a likely credential", () => {
  const root = mkdtempSync(join(tmpdir(),"ownsoft-portable-secret-"));
  const store = new NotebookStore(join(root,"notebook.sqlite"));
  try {
    store.saveReply(null,"secret", "sk-proj-" + "A".repeat(40));
    const archive = join(root,"blocked.zip");
    assert.throws(()=>exportTestbed(root,archive),/疑似凭据/);
    assert.equal(existsSync(archive),false);
  } finally {store.close();}
});
