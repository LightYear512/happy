const REPORT_SCHEMA_VERSION = 'contract-first-node-test-report/v2';
const OUTCOMES = ['pass', 'fail', 'cancelled', 'skipped', 'todo'];
const SUMMARY_KEYS = ['tests', ...OUTCOMES];
const EVENT_TYPES = new Set([
  'test:complete',
  'test:coverage',
  'test:dequeue',
  'test:diagnostic',
  'test:enqueue',
  'test:fail',
  'test:pass',
  'test:plan',
  'test:start',
  'test:stderr',
  'test:stdout',
  'test:summary',
  'test:watch:drained',
]);

export function parseStructuredTestReport(text, { expectedNames }) {
  let report;
  try {
    report = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw new Error(`malformed structured test report: ${error.message}`);
  }
  requireExactKeys(report, ['schemaVersion', 'complete', 'rows', 'summary'], 'structured test report');
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) throw new Error(`unsupported structured test report schema: ${report.schemaVersion}`);
  if (report.complete !== true) throw new Error('incomplete structured test report');
  if (!Array.isArray(report.rows)) throw new Error('structured test report rows must be an array');

  const expected = requireUniqueNames(expectedNames, 'expected');
  const expectedSet = new Set(expected);
  const seen = new Set();
  const rows = [];
  for (const row of report.rows) {
    requireExactKeys(row, ['name', 'outcome', 'failureClass'], 'terminal row');
    if (typeof row.name !== 'string' || row.name.length === 0) throw new Error('terminal test name must be non-empty');
    if (!OUTCOMES.includes(row.outcome)) throw new Error(`invalid terminal outcome for ${row.name}: ${row.outcome}`);
    if (row.outcome === 'fail') {
      if (typeof row.failureClass !== 'string' || row.failureClass.length === 0) {
        throw new Error(`failed terminal row lacks failure class: ${row.name}`);
      }
    } else if (row.failureClass !== null) {
      throw new Error(`non-failed terminal row has failure class: ${row.name}`);
    }
    if (seen.has(row.name)) throw new Error(`duplicate terminal test name: ${row.name}`);
    if (!expectedSet.has(row.name)) throw new Error(`unexpected terminal test name: ${row.name}`);
    seen.add(row.name);
    rows.push({ name: row.name, outcome: row.outcome, failureClass: row.failureClass });
  }
  for (const name of expected) {
    if (!seen.has(name)) throw new Error(`missing terminal test name: ${name}`);
  }

  const metrics = metricsFor(rows);
  requireExactKeys(report.summary, SUMMARY_KEYS, 'structured test summary');
  for (const key of SUMMARY_KEYS) {
    if (!Number.isInteger(report.summary[key]) || report.summary[key] < 0) {
      throw new Error(`invalid structured test summary metric: ${key}`);
    }
    if (report.summary[key] !== metrics[key]) {
      throw new Error(`structured test summary mismatch for ${key}: expected ${metrics[key]}, got ${report.summary[key]}`);
    }
  }
  rows.sort((left, right) => left.name.localeCompare(right.name));
  return { rows, metrics };
}

export function evaluateExactTestRun({ parsed, parseError, expectedRows, childStatus, childSignal, childError }) {
  const mismatches = [];
  if (parseError) mismatches.push(`report: ${parseError.message}`);
  if (childError) mismatches.push(`child error: ${childError.message ?? String(childError)}`);
  if (childSignal !== null && childSignal !== undefined) mismatches.push(`child signal: ${childSignal}`);

  const expectedEntries = Object.entries(expectedRows ?? {});
  const expectedMetrics = metricsFor(expectedEntries.map(([name, row]) => ({ name, outcome: row.outcome })));
  const expectedStatus = expectedMetrics.fail === 0 ? 0 : 1;
  if (childStatus !== expectedStatus) {
    mismatches.push(`child status: expected ${expectedStatus}, got ${childStatus}`);
  }

  const observedRows = Object.fromEntries((parsed?.rows ?? []).map((row) => [row.name, {
    outcome: row.outcome,
    failureClass: row.failureClass,
  }]));
  const metrics = parsed?.metrics;
  for (const key of SUMMARY_KEYS) {
    const expected = expectedMetrics[key];
    const observed = metrics?.[key] ?? null;
    if (observed !== expected) mismatches.push(`${key}: expected ${expected}, got ${observed}`);
  }
  for (const [name, expected] of expectedEntries) {
    const observed = observedRows[name];
    if (!observed) {
      mismatches.push(`missing row: ${name}`);
      continue;
    }
    if (observed.outcome !== expected.outcome) {
      mismatches.push(`${name} outcome: expected ${expected.outcome}, got ${observed.outcome}`);
    }
    const expectedFailureClass = expected.failureClass ?? null;
    if (observed.failureClass !== expectedFailureClass) {
      mismatches.push(`${name} failureClass: expected ${expectedFailureClass}, got ${observed.failureClass}`);
    }
  }
  return { exact: mismatches.length === 0, mismatches, observedRows, expectedMetrics };
}

export default async function* structuredNodeTestReporter(source) {
  const rows = [];
  for await (const event of source) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      throw new Error('malformed Node test reporter event');
    }
    if (!EVENT_TYPES.has(event.type)) throw new Error(`unknown Node test reporter event: ${event.type}`);
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data ?? {};
    const nesting = data.nesting ?? 0;
    if (!Number.isInteger(nesting) || nesting < 0) throw new Error('invalid Node test event nesting');
    if (nesting !== 0) continue;
    if (typeof data.name !== 'string' || data.name.length === 0) throw new Error('missing Node test terminal name');
    const outcome = terminalOutcome(event.type, data);
    rows.push({
      name: data.name,
      outcome,
      failureClass: outcome === 'fail' ? terminalFailureClass(data) : null,
    });
  }
  rows.sort((left, right) => left.name.localeCompare(right.name));
  yield `${JSON.stringify({
    schemaVersion: REPORT_SCHEMA_VERSION,
    complete: true,
    rows,
    summary: metricsFor(rows),
  })}\n`;
}

function terminalOutcome(type, data) {
  if (data.todo !== undefined && data.todo !== false) return 'todo';
  if (data.skip !== undefined && data.skip !== false) return 'skipped';
  if (type === 'test:pass') return 'pass';
  const failureType = String(data.details?.error?.failureType ?? '');
  return ['aborted', 'cancelledByParent', 'testAborted'].includes(failureType) ? 'cancelled' : 'fail';
}

function terminalFailureClass(data) {
  const message = String(data.details?.error?.message ?? '');
  const match = message.match(/PF4_CONTRACT_UNSATISFIED\[([a-z0-9-]+)\]/);
  return match?.[1] ?? 'unclassified';
}

function metricsFor(rows) {
  const metrics = { tests: rows.length, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const row of rows) {
    if (!OUTCOMES.includes(row.outcome)) throw new Error(`invalid terminal outcome for ${row.name}: ${row.outcome}`);
    metrics[row.outcome] += 1;
  }
  return metrics;
}

function requireUniqueNames(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} test names must be an array`);
  const seen = new Set();
  for (const name of value) {
    if (typeof name !== 'string' || name.length === 0) throw new Error(`${label} test name must be non-empty`);
    if (seen.has(name)) throw new Error(`duplicate ${label} test name: ${name}`);
    seen.add(name);
  }
  return [...value];
}

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`noncanonical ${label}`);
}
