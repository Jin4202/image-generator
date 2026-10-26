import { readFileSync, existsSync, readdirSync } from "node:fs";
const tasks=JSON.parse(readFileSync("docs/tasks/index.json","utf8"));const ids=new Set(tasks.map(t=>t.id));const owners=new Map();const inherited=new Map();let failed=false;
const fail=m=>{console.error(m);failed=true;};
for(const task of tasks){
 for(const dep of task.dependencies)if(!ids.has(dep))fail(`${task.id}: unknown dependency ${dep}`);
 for(const file of [...task.files,task.testFile,`docs/tasks/${task.id}.md`])if(!existsSync(file))fail(`${task.id}: missing ${file}`);
 for(const file of task.files){if(owners.has(file))fail(`Conflicting owners: ${file}`);owners.set(file,task.id);}
 // Follow-up tasks (T13+) take over finished task files or architect-owned shared files via inheritedFiles; `files` stays unique new ownership.
 for(const file of task.inheritedFiles??[]){if(!existsSync(file))fail(`${task.id}: missing ${file}`);if(task.files.includes(file))fail(`${task.id}: ${file} both owned and inherited`);inherited.set(file,[...(inherited.get(file)??[]),task.id]);}
 const text=readFileSync(`docs/tasks/${task.id}.md`,"utf8");for(const section of ["소유 파일","필수 계약","구현 순서","인수 기준","검증 명령","범위 밖"])if(!text.includes(section))fail(`${task.id}: missing ${section}`);
}
function visit(id,chain=[]){if(chain.includes(id)){fail(`Cycle: ${[...chain,id].join(" -> ")}`);return;}for(const dep of tasks.find(t=>t.id===id).dependencies)if(ids.has(dep))visit(dep,[...chain,id]);}
for(const id of ids)visit(id);
const dependsOn=(a,b,seen=new Set())=>{if(seen.has(a))return false;seen.add(a);const deps=tasks.find(t=>t.id===a)?.dependencies??[];return deps.includes(b)||deps.some(d=>dependsOn(d,b,seen));};
for(const [file,list] of inherited){
 // Shared inherited files must be edited serially: every pair of inheritors needs a dependency path.
 for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++)if(!dependsOn(list[i],list[j])&&!dependsOn(list[j],list[i]))fail(`Concurrent inheritors of ${file}: ${list[i]}, ${list[j]}`);
}
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())walk(p);else if(/\.tsx?$/.test(p)){const text=readFileSync(p,"utf8");for(const match of text.matchAll(/unfinished\("(T\d+)"\)/g)){if(!ids.has(match[1]))fail(`Unassigned stub ${p}: ${match[1]}`);if(owners.get(p)!==match[1])fail(`Stub owner mismatch ${p}: ${match[1]} vs ${owners.get(p)}`);}}}}
walk("src");
if(!readFileSync("CLAUDE.md","utf8").includes("AGENTS.md"))fail("Claude entry point missing");
if(failed)process.exitCode=1;else console.log(`Handoff inventory verified: ${tasks.length} tasks; no ownership conflicts`);
