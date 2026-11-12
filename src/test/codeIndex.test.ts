import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CodeIndex, familyOfLanguage, familyOfPath, looksGenerated } from '../codeIndex';

// A small fake project: the "orders" route follows the same pattern the new "invoices" route needs.
const files: Record<string, string> = {
  'src/routes/orders.ts': `import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { OrderSchema } from '../schemas/order';
import { orderService } from '../services/orderService';

export const ordersRouter = Router();

ordersRouter.post('/', requireAuth, validateBody(OrderSchema), async (req, res, next) => {
  try {
    const order = await orderService.create(req.user.id, req.body);
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});
`,
  'src/utils/date.ts': `export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}
`,
  'src/components/Button.tsx': `export function Button({ label, onClick }: { label: string; onClick(): void }) {
  return <button className="btn" onClick={onClick}>{label}</button>;
}
`,
  'scripts/report.py': `from services.order_service import order_service

def require_auth(handler):
    return handler

def report(orders):
    return [o for o in orders if o.total > 100]
`,
};

function build(): CodeIndex {
  const idx = new CodeIndex();
  for (const [path, text] of Object.entries(files)) {
    idx.upsert(path, text);
  }
  return idx;
}

const newRoute = `import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { InvoiceSchema } from '../schemas/invoice';
import { invoiceService } from '../services/invoiceService';

export const invoicesRouter = Router();

invoicesRouter.post('/', `;

test('index: finds the file that follows the same pattern', () => {
  const hits = build().search(newRoute, { family: 'js', budgetChars: 4000, excludePaths: new Set(['src/routes/invoices.ts']) });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].path, 'src/routes/orders.ts');
  assert.match(hits[0].text, /validateBody\(OrderSchema\)/);
});

test('index: unrelated code and other languages are left out', () => {
  const hits = build().search(newRoute, { family: 'js', budgetChars: 4000 });
  const paths = hits.map((h) => h.path);
  assert.ok(!paths.includes('src/utils/date.ts'), 'no shared identifiers');
  assert.ok(!paths.includes('scripts/report.py'), 'different language family');
});

test('index: excluded paths, budget and removal are respected', () => {
  const idx = build();
  assert.deepEqual(idx.search(newRoute, { family: 'js', budgetChars: 4000, excludePaths: new Set(['src/routes/orders.ts']) }), []);
  assert.deepEqual(idx.search(newRoute, { family: 'js', budgetChars: 50 }), [], 'chunk larger than budget');
  idx.remove('src/routes/orders.ts');
  assert.equal(idx.files, 3);
  assert.deepEqual(idx.search(newRoute, { family: 'js', budgetChars: 4000 }), []);
});

test('index: re-indexing a file replaces its old content', () => {
  const idx = build();
  idx.upsert('src/utils/date.ts', 'export const invoiceTotal = (invoiceLines) => invoiceLines.reduce(sumInvoice, 0);');
  const hits = idx.search('const total = invoiceTotal(invoiceLines)', { family: 'js', budgetChars: 4000 });
  assert.equal(hits[0].path, 'src/utils/date.ts');
  assert.ok(!hits[0].text.includes('formatDate'));
});

test('index: large files are cut into windows, and the matching window is returned', () => {
  const idx = new CodeIndex();
  const filler = Array.from({ length: 200 }, (_, i) => `const filler${i} = compute${i}(input${i});`).join('\n');
  const target = 'export async function syncInventory(warehouseId: string) {\n  const stock = await warehouseClient.fetchStock(warehouseId);\n  return reconcileStock(stock);\n}';
  idx.upsert('src/big.ts', `${filler}\n${target}\n${filler}`);
  const hits = idx.search('const stock = await warehouseClient.fetchStock(id); reconcileStock(stock)', { family: 'js', budgetChars: 4000 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /syncInventory/);
  assert.ok(hits[0].text.split('\n').length <= 40);
});

test('index: many add/remove cycles stay consistent (compaction)', () => {
  const idx = new CodeIndex();
  for (let round = 0; round < 30; round++) {
    for (let f = 0; f < 100; f++) {
      idx.upsert(`src/f${f}.ts`, `export function handler${f}_${round}(ctx) {\n  return ctx.render(view${f}, model${round});\n}`);
    }
  }
  assert.equal(idx.files, 100);
  assert.equal(idx.size, 100);
  const hits = idx.search('handler7_29(ctx) { return ctx.render(view7', { family: 'js', budgetChars: 4000 });
  assert.equal(hits[0].path, 'src/f7.ts');
});

test('index: languages, extensions and generated files', () => {
  assert.equal(familyOfPath('a/b.tsx'), 'js');
  assert.equal(familyOfPath('a/b.py'), 'py');
  assert.equal(familyOfPath('README.md'), undefined);
  assert.equal(familyOfLanguage('typescriptreact'), familyOfPath('x.js'));
  assert.equal(looksGenerated('dist/app.min.js', 'x'), true);
  assert.equal(looksGenerated('api.pb.go', 'package api'), true);
  assert.equal(looksGenerated('gen.ts', '// Code generated by protoc. DO NOT EDIT.\nexport {}'), true);
  assert.equal(looksGenerated('src/a.ts', 'export const a = 1;\n'), false);
});

test('index: works with only a couple of files', () => {
  const idx = new CodeIndex();
  idx.upsert('src/routes/orders.ts', files['src/routes/orders.ts']);
  idx.upsert('src/utils/date.ts', files['src/utils/date.ts']);
  const hits = idx.search(newRoute, { family: 'js', budgetChars: 4000 });
  assert.equal(hits[0]?.path, 'src/routes/orders.ts');
});
