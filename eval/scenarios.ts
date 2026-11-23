import type { EvalCase, ScriptStep } from "./cases.ts";

const read = (path: string): ScriptStep => ({ tool: "read", args: { path } });
const code = (path: string, content: string): ScriptStep => ({ tool: "write", args: { path, content } });
const json = (path: string, value: unknown): ScriptStep => code(path, `${JSON.stringify(value, null, 2)}\n`);
const bash = (command: string): ScriptStep => ({ tool: "bash", args: { command, timeout: 10 } });
const report: ScriptStep = { text: "The goal is delivered and self-checked; reporting the result." };
const checkpoint = (progress: string, blockers: string[]): ScriptStep => ({ tool: "dwell.work", args: { progress, blockers } });
const node = (program: string): string => `node --input-type=module -e '${program.replaceAll("'", "'\\''")}'`;
const comparabilityNote = "Version 4 replaces the verification-contract and operator-review workflow with the fire-and-forget /goal flow: goals are host-created, agents self-verify with bash, and results are reported in chat. Success rates are not directly comparable with earlier versions.";
const recoveryGuidance = " Inspect the source structure and compare self-authored expectations with the requirements. Checkpoint progress and blockers with dwell.work as you go; verify by rerunning your own checks with bash, and report the delivered result directly in chat when done.";
const invoiceBoundaries = node(`import assert from "node:assert/strict"; import {cents} from "./money.ts"; import {invoice} from "./invoice.ts";
assert.equal(cents("14.2"),1420); assert.equal(cents("001.23"),123); assert.equal(cents("0.00"),0);
for(const value of ["-0.01","2.345","6e1","4.","90071992547409.92"]) assert.throws(()=>cents(value));
const lines=[{price:"3.25",quantity:4},{price:"0.50",quantity:2}]; const original=JSON.stringify(lines);
assert.equal(invoice(lines,100,60),1360); assert.equal(invoice(lines,1400,60),0); assert.equal(JSON.stringify(lines),original);
for(const quantity of [-2,0.2,Infinity]) assert.throws(()=>invoice([{price:"1.00",quantity}]));
assert.throws(()=>invoice([],0,-1)); assert.throws(()=>invoice([],NaN)); console.log("invoice boundary checks passed");`);
const ledgerCheck = node(`import assert from "node:assert/strict"; import fs from "node:fs"; import {reconcile} from "./reconcile.ts";
const invoices=JSON.parse(fs.readFileSync("invoices.json","utf8")); const rows=fs.readFileSync("payments.jsonl","utf8").trim().split("\\n").map(JSON.parse);
assert.deepEqual(JSON.parse(fs.readFileSync("result.json","utf8")),reconcile(invoices,rows));
const extraInvoices=[{id:"N",cents:75},{id:"M",cents:50}]; const extraRows=[{id:"a",invoice:"M",cents:-1},{id:"a",invoice:"M",cents:60},{id:"b",invoice:"missing",cents:5},{id:"b",invoice:"N",cents:5},{id:"a",invoice:"M",cents:60},null]; const original=JSON.stringify([extraInvoices,extraRows]);
assert.deepEqual(reconcile(extraInvoices,extraRows),{balances:[{id:"M",paidCents:60,balanceCents:-10},{id:"N",paidCents:0,balanceCents:75}],rejected:[{line:1,reason:"schema"},{line:3,reason:"unknown_invoice"},{line:4,reason:"conflict"},{line:5,reason:"duplicate"},{line:6,reason:"schema"}]}); assert.equal(JSON.stringify([extraInvoices,extraRows]),original); console.log("ledger checks passed");`);
const policyCheck = node(`import assert from "node:assert/strict"; import fs from "node:fs"; import {shouldRetry} from "./retry.ts";
const policy=JSON.parse(fs.readFileSync("policy.json","utf8")); assert.equal(policy.maxRetries,2); assert.deepEqual(policy.statuses,[429,503]);
for(const method of ["GET","head","POST","PUT","DELETE","OPTIONS","PATCH"]) for(const status of [200,429,500,503]) for(const attempt of [-1,0,1,2,0.5,NaN]) assert.equal(shouldRetry(method,status,attempt),policy.methods.includes(method.toUpperCase())&&policy.statuses.includes(status)&&Number.isInteger(attempt)&&attempt>=0&&attempt<policy.maxRetries); console.log("retry policy checks passed");`);
const releaseCheck = node(`import assert from "node:assert/strict"; import fs from "node:fs";
const releases=JSON.parse(fs.readFileSync("releases.json","utf8")); const incidents=JSON.parse(fs.readFileSync("incidents.json","utf8"));
const ready=releases.filter(r=>Object.values(r.checks).every(v=>v===true)&&incidents.filter(i=>i.service===r.service).every(i=>i.status==="resolved")).map(r=>r.service).sort();
const blocked=releases.map(r=>r.service).filter(s=>!ready.includes(s)).sort(); const blockers=incidents.filter(i=>i.status==="open").map(i=>({service:i.service,incident:i.id,reason:i.reason})).sort((a,b)=>a.service.localeCompare(b.service)||a.incident.localeCompare(b.incident));
const totalChecks=releases.reduce((n,r)=>n+Object.keys(r.checks).length,0); assert.deepEqual(JSON.parse(fs.readFileSync("result.json","utf8")),{ready,blocked,blockers,totalChecks});
const evidence=Object.fromEntries(releases.map(r=>[r.service,["release:"+r.service,...incidents.filter(i=>i.service===r.service).sort((a,b)=>a.id.localeCompare(b.id)).map(i=>i.id+":"+i.status)]])); assert.deepEqual(JSON.parse(fs.readFileSync("evidence.json","utf8")),evidence); console.log("release artifact checks passed");`);
const money = `export function cents(value: string): number {
  if (!/^\\d+(?:\\.\\d{1,2})?$/.test(value)) throw new Error('invalid price');
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('invalid price');
  return result;
}\n`;
const invoice = `import { cents } from './money.ts';
export function invoice(lines: { price: string; quantity: number }[], discountCents = 0, shippingCents = 0): number {
  if (![discountCents, shippingCents].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid charge');
  const subtotal = lines.reduce((sum, line) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 0) throw new Error('invalid quantity');
    return sum + cents(line.price) * line.quantity;
  }, 0);
  const net = Math.max(0, subtotal - discountCents);
  return net === 0 ? 0 : net + shippingCents;
}\n`;
const reconcile = `type Payment = { id: string; invoice: string; cents: number };
export function reconcile(invoices: { id: string; cents: number }[], rows: unknown[]) {
  const known = new Map(invoices.map(item => [item.id, item.cents]));
  const seen = new Map<string, Payment>();
  const paid = new Map<string, number>();
  const rejected: { line: number; reason: string }[] = [];
  rows.forEach((row, i) => {
    const p = row as Payment | null;
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || typeof p.invoice !== 'string' || !p.invoice || !Number.isSafeInteger(p.cents) || p.cents <= 0) { rejected.push({line:i+1,reason:'schema'}); return; }
    const previous = seen.get(p.id);
    if (previous) { rejected.push({line:i+1,reason: previous.invoice === p.invoice && previous.cents === p.cents ? 'duplicate' : 'conflict'}); return; }
    seen.set(p.id, p);
    if (!known.has(p.invoice)) { rejected.push({line:i+1,reason:'unknown_invoice'}); return; }
    paid.set(p.invoice, (paid.get(p.invoice) ?? 0) + p.cents);
  });
  return { balances: invoices.map(item => ({id:item.id, paidCents:paid.get(item.id) ?? 0, balanceCents:item.cents-(paid.get(item.id) ?? 0)})).sort((a,b)=>a.id.localeCompare(b.id)), rejected };
}\n`;
const ledgerResult = { balances: [{ id: "A", paidCents: 1000, balanceCents: 0 }, { id: "B", paidCents: 450, balanceCents: -50 }, { id: "C", paidCents: 0, balanceCents: 600 }], rejected: [{ line: 2, reason: "schema" }, { line: 4, reason: "duplicate" }, { line: 5, reason: "conflict" }, { line: 6, reason: "unknown_invoice" }, { line: 7, reason: "schema" }, { line: 8, reason: "schema" }] };
const policy = { maxRetries: 2, methods: ["GET", "HEAD"], statuses: [429, 503] };
const retry = `import policy from './policy.json' with { type: 'json' };
export function shouldRetry(method: string, status: number, attempt: number): boolean {
  return Number.isInteger(attempt) && attempt >= 0 && attempt < policy.maxRetries && policy.methods.includes(method.toUpperCase()) && policy.statuses.includes(status);
}\n`;
const releaseResult = { ready: ["api", "web"], blocked: ["worker"], blockers: [{ service: "worker", incident: "INC-8", reason: "rollback_test_missing" }], totalChecks: 9 };
const releaseEvidence = { api: ["release:api", "INC-7:resolved"], web: ["release:web"], worker: ["release:worker", "INC-8:open"] };

export const scenarios: EvalCase[] = [
	{
		id: "invoice-workflow-repair", version: 4, comparabilityNote,
		task: "Repair the invoice library. Run `node acceptance.ts` first and inspect the failure before editing. Fix money.ts and invoice.ts only. cents(string) must parse nonnegative decimal amounts with zero, one or two fractional digits into exact safe integer cents; reject negative, malformed, too-precise or unsafe amounts. invoice(lines, discountCents=0, shippingCents=0) multiplies each price by its nonnegative integer quantity, subtracts discount with a floor of zero, then adds shipping only when the discounted subtotal is positive. Reject invalid quantities/charges. Preserve caller inputs and named exports. Run the unchanged acceptance check again after repair plus native Node checks you derive for valid, invalid and boundary inputs, then report the repair directly in chat. Do not add files or change acceptance.ts or sample.json." + recoveryGuidance,
		fixtures: { "money.ts": "export const cents = (value: string): number => parseInt(value, 10) * 100;\n", "invoice.ts": "import { cents } from './money.ts';\nexport const invoice = (lines: {price:string;quantity:number}[], discountCents=0, shippingCents=0) => lines.reduce((sum,line)=>sum+cents(line.price),0)-discountCents+shippingCents;\n", "sample.json": '[{"price":"12.50","quantity":2},{"price":"0.99","quantity":3}]\n', "acceptance.ts": "import assert from 'node:assert/strict';\nimport {invoice} from './invoice.ts';\nimport {cents} from './money.ts';\nimport lines from './sample.json' with {type:'json'};\nassert.equal(cents('12.50'),1250);\nassert.equal(invoice(lines,300,500),2997);\nassert.equal(invoice([],0,500),0);\nconsole.log('invoice acceptance passed');\n" },
		mutable: ["money.ts", "invoice.ts"], outputs: {}, expected: null,
		script: [bash("node acceptance.ts"), read("money.ts"), read("invoice.ts"), code("money.ts", money), code("invoice.ts", invoice), bash("node acceptance.ts"), bash(invoiceBoundaries), report],
		hiddenAssertions: `import assert from 'node:assert/strict'; import {cents} from './money.ts'; import {invoice} from './invoice.ts';
for (const [s,n] of [['0',0],['0.1',10],['10.09',1009],['0002.05',205]]) assert.equal(cents(s),n);
for (const s of ['-1','1.001','1x','','1.','NaN','9007199254740992']) assert.throws(()=>cents(s));
for(let q=0;q<12;q++){ const lines=[{price:'1.07',quantity:q},{price:'0.03',quantity:2}]; const before=JSON.stringify(lines); assert.equal(invoice(lines,30,90),Math.max(0,q*107+6-30)+(q*107+6>30?90:0)); assert.equal(JSON.stringify(lines),before); }
assert.equal(invoice([{price:'2',quantity:3}],9999,50),0); assert.throws(()=>invoice([{price:'2',quantity:1.5}])); assert.throws(()=>invoice([], -1)); assert.throws(()=>invoice([],0,NaN));`,
	},
	{
		id: "ledger-reconciliation", version: 4, comparabilityNote,
		task: "Implement named export reconcile(invoices, rows) in reconcile.ts, then run cli.ts to produce result.json and check its contents. Each valid invoice has a unique id and positive integer cents. Payment rows must be objects with nonempty string id/invoice and positive safe integer cents; otherwise reject as schema. Use 1-based row numbers. Ignore invalid rows before ID deduplication. The first schema-valid row owns a payment ID, even if its invoice is unknown. Later identical invoice/cents rows are duplicate; different rows with that ID are conflict. Reject first valid payments to unknown invoices as unknown_invoice. Sum accepted payments. Return {balances:[{id,paidCents,balanceCents}],rejected:[{line,reason}]}, sorted by invoice id and input line respectively; keep negative balances for overpayments. Preserve inputs. Only edit reconcile.ts and create result.json; preserve all fixtures and cli.ts. Verify with native Node checks that the implementation handles additional inputs, not only the provided fixture, then report the delivered artifacts directly in chat." + recoveryGuidance,
		fixtures: { "invoices.json": '[{"id":"C","cents":600},{"id":"A","cents":1000},{"id":"B","cents":400}]\n', "payments.jsonl": '{"id":"p1","invoice":"A","cents":700}\n{"id":"p2","invoice":"A","cents":"300"}\n{"id":"p2","invoice":"A","cents":300}\n{"id":"p2","invoice":"A","cents":300}\n{"id":"p1","invoice":"B","cents":700}\n{"id":"p9","invoice":"Z","cents":10}\nnull\n{"id":"bad","invoice":"C","cents":-10}\n{"id":"p3","invoice":"B","cents":450}\n', "reconcile.ts": "export function reconcile(invoices: unknown[], rows: unknown[]) { throw new Error('not implemented'); }\n", "cli.ts": "import {readFile,writeFile} from 'node:fs/promises';\nimport {reconcile} from './reconcile.ts';\nconst invoices=JSON.parse(await readFile('invoices.json','utf8'));\nconst rows=(await readFile('payments.jsonl','utf8')).trim().split('\\n').map(line=>JSON.parse(line));\nawait writeFile('result.json',JSON.stringify(reconcile(invoices,rows),null,2)+'\\n');\n" },
		mutable: ["reconcile.ts"], outputs: { "result.json": ledgerResult }, expected: null,
		script: [read("invoices.json"), read("payments.jsonl"), read("cli.ts"), code("reconcile.ts", reconcile), bash("node cli.ts"), bash(ledgerCheck), report],
		hiddenAssertions: `import assert from 'node:assert/strict'; import {reconcile} from './reconcile.ts';
const invoices=[{id:'Y',cents:90},{id:'X',cents:101}]; const rows=[{id:'p',invoice:'X',cents:0},{id:'p',invoice:'X',cents:31},{id:'q',invoice:'Z',cents:10},{id:'q',invoice:'Y',cents:10},{id:'p',invoice:'X',cents:31},{id:'r',invoice:'Y',cents:100},{id:'s',invoice:'X',cents:1.1},[],{id:'',invoice:'X',cents:1}]; const before=JSON.stringify([invoices,rows]);
assert.deepEqual(reconcile(invoices,rows),{balances:[{id:'X',paidCents:31,balanceCents:70},{id:'Y',paidCents:100,balanceCents:-10}],rejected:[{line:1,reason:'schema'},{line:3,reason:'unknown_invoice'},{line:4,reason:'conflict'},{line:5,reason:'duplicate'},{line:7,reason:'schema'},{line:8,reason:'schema'},{line:9,reason:'schema'}]}); assert.equal(JSON.stringify([invoices,rows]),before); assert.deepEqual(reconcile([],[]),{balances:[],rejected:[]});`,
	},
	{
		id: "policy-clarification", version: 4, comparabilityNote,
		task: "Read decisions.txt and the retry client. The notes conflict about which HTTP methods may retry. Before editing any files, checkpoint your progress and the clarification blocker with dwell.work, then ask me which methods to allow; do not infer acceptance from a proposal. The host may restart while awaiting my answer. After my answer, update policy.json and retry.ts only. shouldRetry(method,status,attempt) must use the policy, accept method names case-insensitively, allow retries only for 429/503 and nonnegative integer attempt < maxRetries, and return false otherwise. maxRetries means retries after the original request. Keep named exports and preserve the notes. Run native Node checks for the approved and denied methods, boundary attempts and status codes, clear the recorded blocker with a checkpoint, and report the delivered policy directly in chat. Create no additional files." + recoveryGuidance,
		fixtures: { "decisions.txt": "2026-11-01 DECISION retry 429/503 for every HTTP method; maxRetries=3\n2026-11-05 PROPOSAL allow idempotent methods only; maxRetries=2\n2026-11-06 REQUEST maxRetries=2 is approved, but confirm exactly which HTTP methods before implementation.\n", "policy.json": '{"maxRetries":3,"methods":["GET","HEAD","POST","PUT","DELETE"],"statuses":[429,503]}\n', "retry.ts": "export const shouldRetry = (_method: string, status: number, attempt: number) => status >= 500 && attempt <= 3;\n" },
		mutable: ["retry.ts", "policy.json"], outputs: { "policy.json": policy }, expected: null,
		clarification: "Allow GET and HEAD only, including lowercase spellings. Keep POST, PUT and DELETE disabled; maxRetries=2, statuses 429 and 503.", clarificationSubject: "\\b(?:method|methods|GET|HEAD|POST|PUT|DELETE)\\b|方法|重试", clarificationFiles: ["decisions.txt", "policy.json", "retry.ts"],
		reopenAfterClarification: true,
			script: [read("decisions.txt"), read("policy.json"), read("retry.ts"), checkpoint("Read the conflicting decisions and current retry implementation.", ["The allowed HTTP methods require user clarification."]), { text: "Which HTTP methods should be allowed to retry?" }, json("policy.json", policy), code("retry.ts", retry), bash(policyCheck), checkpoint("Implemented and checked the policy using the approved GET and HEAD methods.", []), report],
		hiddenAssertions: `import assert from 'node:assert/strict'; import {shouldRetry} from './retry.ts'; for(const method of ['GET','get','HEAD','HeAd','POST','PUT','DELETE','OPTIONS','PATCH'])for(const status of [200,400,429,500,502,503])for(const attempt of [-1,0,1,2,3,0.5,NaN]) assert.equal(shouldRetry(method,status,attempt),['GET','HEAD'].includes(method.toUpperCase())&&[429,503].includes(status)&&Number.isInteger(attempt)&&attempt>=0&&attempt<2);`,
	},
	{
		id: "release-background-audit", version: 4, comparabilityNote,
		task: "Prepare a release readiness audit using releases.json and incidents.json. Start exactly one read-only background worker named totals to cross-check both sources and report structured findings with source record IDs. Independently inspect both sources in the parent while it works, then call the separate dwell.task.wait tool with arguments={} alone to end the current run until the Reporter's follow-up resumes you; do not poll status or use a process to wait. A service is ready only when all three release checks are true and every incident for it is resolved. After its report, independently reread both sources in the parent, and verify counts with Node before writing result.json and evidence.json. result.json fields: ready and blocked (sorted service names), blockers (sorted by service, one {service,incident,reason} per open incident; reason from that incident), totalChecks (number of named release checks across all services). evidence.json maps every service to ['release:<service>', ...incident IDs suffixed ':open' or ':resolved', sorted by incident ID]. After writing both artifacts, verify both with native Node commands that derive them from the sources, then report the audit directly in chat. Preserve sources; create only these two JSON artifacts. The child must not write or use bash." + recoveryGuidance,
		fixtures: { "releases.json": '[{"service":"worker","checks":{"build":true,"tests":true,"rollback":false}},{"service":"api","checks":{"build":true,"tests":true,"rollback":true}},{"service":"web","checks":{"build":true,"tests":true,"rollback":true}}]\n', "incidents.json": '[{"id":"INC-8","service":"worker","status":"open","reason":"rollback_test_missing"},{"id":"INC-7","service":"api","status":"resolved","reason":"timeout"}]\n' },
		outputs: { "result.json": releaseResult, "evidence.json": releaseEvidence }, expected: null,
		script: [{ tool: "dwell.task", args: { action: "start", name: "totals", message: "Read releases.json and incidents.json; return readiness, blockers, total check count, and source record IDs. Do not write or use bash." } }, read("releases.json"), read("incidents.json"), { tool: "dwell.task.wait", args: {} }],
		background: { answer: JSON.stringify({ result: releaseResult, evidence: releaseEvidence }), output: releaseResult, script: [read("releases.json"), read("incidents.json")], reportScript: [read("releases.json"), read("incidents.json"), bash("node --input-type=module -e 'import fs from \"node:fs\"; import assert from \"node:assert/strict\"; const r=JSON.parse(fs.readFileSync(\"releases.json\",\"utf8\")); const i=JSON.parse(fs.readFileSync(\"incidents.json\",\"utf8\")); assert.equal(r.reduce((n,x)=>n+Object.keys(x.checks).length,0),9); assert.deepEqual(r.filter(x=>Object.values(x.checks).every(Boolean)&&!i.some(y=>y.service===x.service&&y.status!==\"resolved\")).map(x=>x.service).sort(),[\"api\",\"web\"])'"), json("result.json", releaseResult), json("evidence.json", releaseEvidence), bash(releaseCheck), report] },
	},
];
