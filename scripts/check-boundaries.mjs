import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
const root=resolve("src");
function walk(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(dir,e.name)):/\.tsx?$/.test(e.name)?[resolve(dir,e.name)]:[]); }
let failed=false;
for(const file of walk(root)) {
 const source=readFileSync(file,"utf8");const from=relative(root,file).replaceAll("\\","/");
 for(const m of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
  const spec=m[1];const target=spec.startsWith("@/")?spec.slice(2):spec.startsWith(".")?relative(root,resolve(dirname(file),spec)).replaceAll("\\","/"):null;
  const layer=from.split("/")[0];const allowed={contracts:["contracts"],domain:["contracts","domain"],application:["contracts","domain","application"]}[layer];
  const outerAllowed={infrastructure:["contracts","domain","application","infrastructure"],server:["contracts","domain","application","infrastructure","server"],worker:["contracts","domain","application","infrastructure","server","worker"]}[layer];
  const badOuter=outerAllowed && target && !outerAllowed.includes(target.split("/")[0]);
  const badRoute=from.startsWith("app/api/") && target && !["contracts","domain","application","server","app"].includes(target.split("/")[0]);
  const badInner=allowed && (target ? !allowed.includes(target.split("/")[0]) : !["zod"].includes(spec));
  const client=from.startsWith("components/") || /(^|\/)page\.tsx$/.test(from) || source.startsWith('"use client"');
  const badClient=client && (target && /^(server|application|infrastructure)\//.test(target) || spec.startsWith("node:") || ["@fal-ai/client","better-sqlite3","drizzle-orm"].includes(spec));
  if(badInner || badOuter || badRoute || badClient) {console.error(`${from}: forbidden dependency ${spec}`);failed=true;}
 }
}
if(failed)process.exitCode=1;else console.log("Module boundaries verified");
