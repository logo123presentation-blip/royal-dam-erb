import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { askGemini, calculateTotals, extractWithGemini, normalizeItems, normalizeUploadedFilename, parseGeminiItems } from '../src/services/quantityTakeoff.js';
import { buildQuantityTakeoffWorkbook } from '../src/services/quantityTakeoffExcel.js';

const items = normalizeItems([{ i: '1.1.2', description: 'خرسانة', unit: 'م3', quantity: 2, unit_price: 150 }]);
assert.equal(items[0].itemNo, '1.1.2');
assert.equal(normalizeItems([{ i: '1', description: 'قسم أعمال' }])[0].quantity, 0);
assert.deepEqual(normalizeItems([{ i: 'F1', description: 'قاعدة', location: 'الأساسات', unit: 'عدد', quantity: 3, p: 'صفحة 6' }])[0].reference, 'صفحة 6');
assert.deepEqual(calculateTotals(items), { itemCount: 1, total: 300 });
assert.equal(normalizeItems([{ description: 'وصف بند '.repeat(100), quantity: 1 }]).length, 1);
assert.throws(() => normalizeItems([{ description: 'وصف بند '.repeat(600), quantity: 1 }]), /too long/);
assert.equal(parseGeminiItems('{"items":[{"description":"حديد","unit":"طن","quantity":3,"unit_price":100}]}')[0].total, 300);
assert.deepEqual(parseGeminiItems('```json {"items":[{"d":"حديد","q":1}]} ```')[0].description, 'حديد');
const arabicFilename = 'مخطط الحصر.xlsx';
assert.equal(normalizeUploadedFilename(Buffer.from(arabicFilename, 'utf8').toString('latin1')), arabicFilename);
assert.equal(normalizeUploadedFilename('takeoff.xlsx'), 'takeoff.xlsx');

const pdfDocument = await PDFDocument.create();
pdfDocument.addPage(); pdfDocument.addPage();
const pdfBuffer = Buffer.from(await pdfDocument.save());
let uploadedDeleted = false;
let fileStateChecks = 0;
let uploadParameters;
let generationParameters;
const pdfClient = {
  files: {
    upload: async parameters => {
      uploadParameters = parameters;
      assert.ok(parameters.file instanceof Blob);
      assert.equal(Buffer.from(await parameters.file.arrayBuffer()).toString(), pdfBuffer.toString());
      assert.equal(parameters.config.mimeType, 'application/pdf');
      return { name: 'files/test-pdf', uri: 'https://files.example/test', mimeType: 'application/pdf', state: 'PROCESSING' };
    },
    get: async parameters => { fileStateChecks++; assert.deepEqual(parameters, { name: 'files/test-pdf' }); return { name: 'files/test-pdf', uri: 'https://files.example/test', mimeType: 'application/pdf', state: 'ACTIVE' }; },
    delete: async parameters => { assert.deepEqual(parameters, { name: 'files/test-pdf' }); uploadedDeleted = true; },
  },
  models: { generateContent: async parameters => {
    generationParameters = parameters;
    return { text: '{"items":[{"d":"خرسانة","u":"م3","q":4,"unit_price":20,"p":"صفحة 2"}]}' };
  } },
};
const extracted = await extractWithGemini({ originalname: 'short.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }, {
  apiKey: 'test-key', clientFactory: () => pdfClient,
});
assert.equal(uploadParameters.config.displayName, 'short.pdf');
assert.equal(uploadParameters.config.httpOptions.timeout, 180_000);
assert.equal(generationParameters.model, 'gemini-3.1-pro-preview');
assert.equal(generationParameters.config.responseMimeType, 'application/json');
assert.equal(generationParameters.config.httpOptions.timeout, 180_000);
assert.match(generationParameters.contents[0].parts[0].text, /قم بعمل حصر شامل ودقيق/);
assert.deepEqual(generationParameters.contents[0].parts[1], { fileData: { mimeType: 'application/pdf', fileUri: 'https://files.example/test' } });
assert.equal(extracted.items[0].total, 80);
assert.equal(uploadedDeleted, true);
assert.equal(fileStateChecks, 1);

const splitPdfDocument = await PDFDocument.create();
for (let index = 0; index < 5; index++) splitPdfDocument.addPage();
const splitPdfBuffer = Buffer.from(await splitPdfDocument.save());
let splitUploads = 0;
const splitResult = await extractWithGemini({ originalname: 'split.pdf', mimetype: 'application/pdf', buffer: splitPdfBuffer }, {
  apiKey: 'test-key', clientFactory: () => ({
    files: {
      upload: async () => ({ name: `files/split-${++splitUploads}`, uri: `uri-${splitUploads}`, mimeType: 'application/pdf' }),
      delete: async () => {},
    },
    models: { generateContent: async () => ({ text: `{"items":[{"d":"صف batch ${splitUploads}","q":1}]}` }) },
  }),
});
assert.equal(splitUploads, 2);
assert.equal(splitResult.items.length, 2);
assert.equal(splitResult.items[0].reference, 'الصفحات 1-4');
assert.equal(splitResult.items[1].reference, 'الصفحات 5-5');
const rotatedKeys = [];
const rotatedResult = await extractWithGemini({ originalname: 'rotated.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }, {
  apiKey: 'key-1', apiKeys: ['key-2'], clientFactory: key => ({
    files: { upload: async () => ({ name: `files/${key}`, uri: `uri-${key}`, mimeType: 'application/pdf' }), delete: async () => {} },
    models: { generateContent: async parameters => {
      rotatedKeys.push(`${key}:${parameters.model}`);
      if (key === 'key-1') { const error = new Error('RESOURCE_EXHAUSTED'); error.status = 429; throw error; }
      return { text: '{"items":[{"d":"second key item","q":1}]}' };
    } },
  }),
});
assert.deepEqual(rotatedKeys, ['key-1:gemini-3.1-pro-preview', 'key-1:gemini-3.8-flash', 'key-2:gemini-3.1-pro-preview']);
assert.equal(rotatedResult.items[0].description, 'second key item');
const thirdKeyAttempts = [];
const thirdKeyResult = await extractWithGemini({ originalname: 'third-key.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }, {
  apiKey: 'key-1', apiKeys: ['key-2', 'key-3'], clientFactory: key => ({
    files: { upload: async () => ({ name: `files/${key}`, uri: `uri-${key}`, mimeType: 'application/pdf' }), delete: async () => {} },
    models: { generateContent: async parameters => {
      thirdKeyAttempts.push(`${key}:${parameters.model}`);
      if (key !== 'key-3') { const error = new Error('RESOURCE_EXHAUSTED'); error.status = 429; throw error; }
      return { text: '{"items":[{"d":"third key item","q":1}]}' };
    } },
  }),
});
assert.deepEqual(thirdKeyAttempts, ['key-1:gemini-3.1-pro-preview', 'key-1:gemini-3.8-flash', 'key-2:gemini-3.1-pro-preview', 'key-2:gemini-3.8-flash', 'key-3:gemini-3.1-pro-preview']);
assert.equal(thirdKeyResult.items[0].description, 'third key item');

let failedUploadDeleted = false;
await assert.rejects(extractWithGemini({ originalname: 'bad-json.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }, {
  apiKey: 'test-key', clientFactory: () => ({
    files: { upload: async () => ({ name: 'files/bad', uri: 'uri' }), delete: async () => { failedUploadDeleted = true; } },
    models: { generateContent: async () => ({ text: 'not json' }) },
  }),
}), /valid JSON/);
assert.equal(failedUploadDeleted, true);
await assert.rejects(extractWithGemini({ originalname: 'unavailable.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }, {
  apiKey: 'test-key', clientFactory: () => ({
    files: { upload: async () => { const error = new Error('not found'); error.status = 404; throw error; }, delete: async () => {} },
    models: { generateContent: async () => ({ text: '{}' }) },
  }),
}), /invalid items array/);
const modelAttempts = [];
const retiredModelResult = await extractWithGemini({ originalname: 'legacy-model.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }, {
  apiKey: 'test-key', model: 'gemini-2.5-flash', clientFactory: () => ({
    files: { upload: async () => ({ name: 'files/legacy', uri: 'uri' }), delete: async () => {} },
    models: { generateContent: async parameters => {
      modelAttempts.push(parameters.model);
      if (parameters.model === 'gemini-2.5-flash') throw new Error('This model is no longer available to new users');
      return { text: '{"items":[{"d":"fallback","q":1}]}' };
    } },
  }),
});
assert.deepEqual(modelAttempts, ['gemini-2.5-flash', 'gemini-flash-latest']);
assert.equal(retiredModelResult.items.length, 1);
const quotaAttempts = [];
await assert.rejects(extractWithGemini({ originalname: 'quota.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }, {
  apiKey: 'test-key', clientFactory: () => ({
    files: { upload: async () => ({ name: 'files/quota', uri: 'uri' }), delete: async () => {} },
    models: { generateContent: async parameters => { quotaAttempts.push(parameters.model); const error = new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'); throw error; } },
  }),
}), error => { assert.match(error.message, /تم بلوغ الحد اليومي/); assert.equal(error.status, 429); return true; });
assert.deepEqual(quotaAttempts, ['gemini-3.1-pro-preview', 'gemini-3.8-flash']);
await assert.rejects(extractWithGemini({ originalname: 'empty.pdf', buffer: Buffer.alloc(0) }, { apiKey: 'test-key' }), /فارغ/);
await assert.rejects(extractWithGemini({ originalname: 'corrupt.pdf', mimetype: 'application/pdf', buffer: Buffer.from('not a pdf') }, { apiKey: 'test-key' }), /PDF/);
await assert.rejects(extractWithGemini({ originalname: 'short.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }, { apiKey: '' }), /GEMINI_API_KEY/);

const sourceBook = new ExcelJS.Workbook();
const sourceSheet = sourceBook.addWorksheet('مقايسة');
sourceSheet.addRow(['البند', 'الوحدة', 'الكمية', 'سعر الوحدة']);
sourceSheet.addRow(['خرسانة مسلحة', 'م3', 12, 850]);
const sourceBuffer = Buffer.from(await sourceBook.xlsx.writeBuffer());
let workbookContents;
const workbookTakeoff = await extractWithGemini({
  originalname: 'مقايسة.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: sourceBuffer,
}, {
  apiKey: 'test-key', clientFactory: () => ({ models: { generateContent: async parameters => {
    workbookContents = parameters.contents[0].parts[1].text;
    return { text: '{"items":[{"c":"خرسانة","d":"خرسانة مسلحة","u":"م3","q":12,"unit_price":850,"p":"صفحة 17 - بند 1","n":"تفصيل"}]}' };
  } } }),
});
assert.match(workbookContents, /مقايسة/);
assert.match(workbookContents, /خرسانة مسلحة\tم3\t12\t850/);
assert.equal(workbookTakeoff.items[0].total, 10200);
await assert.rejects(extractWithGemini({ originalname: 'empty.xlsx', buffer: Buffer.from('not a workbook') }, { apiKey: 'test-key' }), /Excel|ملف/);
await assert.rejects(extractWithGemini({ originalname: 'drawing.dwg', buffer: Buffer.from('binary') }, { apiKey: 'test-key' }), /DWG/);
let dxfPrompt = '';
const dxfResult = await extractWithGemini({ originalname: 'drawing.dxf', buffer: Buffer.from('0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nF1\n0\nINSERT\n2\nF1\n0\nTEXT\n1\nF1 footing\n0\nENDSEC\n0\nEOF\n', 'utf8') }, {
  apiKey: 'test-key', clientFactory: () => ({ models: { generateContent: async parameters => { dxfPrompt = parameters.contents[0].parts[1].text; return { text: '{"items":[{"d":"قاعدة F1","u":"قطعة","q":2,"p":"DXF"}]}' }; } } }),
});
assert.equal(dxfResult.items[0].quantity, 2);
assert.match(dxfPrompt, /blockInsertCounts/);
assert.match(dxfPrompt, /F1/);

let chatParameters;
const englishAnswer = await askGemini('How do I calculate concrete volume?', {
  apiKey: 'test-key', clientFactory: () => ({ models: { generateContent: async parameters => {
    chatParameters = parameters;
    return { text: 'Multiply length by width by depth.' };
  } } }),
});
assert.match(chatParameters.config.systemInstruction, /For an English message, answer in English/);
assert.match(chatParameters.config.systemInstruction, /Never default to Arabic/);
assert.equal(chatParameters.config.temperature, 0);
assert.equal(chatParameters.config.maxOutputTokens, 32768);
assert.equal(chatParameters.contents[0].role, 'user');
assert.equal(englishAnswer, 'Multiply length by width by depth.');
let historyParameters;
await askGemini('Continue the calculation.', {
  apiKey: 'test-key',
  history: [{ role: 'user', content: 'The slab is 5 by 4 by 0.2.' }, { role: 'model', content: 'The volume is 4 m3.' }],
  clientFactory: () => ({ models: { generateContent: async parameters => { historyParameters = parameters; return { text: 'Add reinforcement next.' }; } } }),
});
assert.equal(historyParameters.contents.length, 3);
assert.equal(historyParameters.contents[1].role, 'model');
const extractionAnswer = await askGemini('extract the quantities', {
  apiKey: 'test-key',
  files: [{ originalname: 'drawing.pdf', mimetype: 'application/pdf', buffer: pdfBuffer }],
  clientFactory: () => ({
    files: { upload: async () => ({ name: 'files/extract', uri: 'uri', mimeType: 'application/pdf' }), delete: async () => {} },
    models: { generateContent: async parameters => {
      assert.equal(parameters.model, 'gemini-3.1-pro-preview');
      return { text: '{"items":[{"i":"C1","d":"Column | C1","u":"عدد","q":3,"n":"صفحة 5"}]}' };
    } },
  }),
});
assert.match(extractionAnswer, /\| # \| رقم البند \| الوصف/);
assert.match(extractionAnswer, /Column \/ C1/);
assert.match(await askGemini('ما حجم الخرسانة؟', { apiKey: 'test-key', clientFactory: () => ({ models: { generateContent: async () => ({ text: '' }) } }) }), /لم تصل إجابة/);
assert.match(await askGemini('What is the concrete volume?', { apiKey: 'test-key', clientFactory: () => ({ models: { generateContent: async () => ({ text: '' }) } }) }), /did not return an answer/);

const buffer = await buildQuantityTakeoffWorkbook({ items: workbookTakeoff.items, sourceFiles: [{ name: 'مقايسة.xlsx' }], total: 10200 });
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(buffer);
assert.equal(workbook.getWorksheet('حصر الكميات').getCell('I7').value.formula, 'SUM(G7:H7)');
assert.match(workbook.getWorksheet('حصر الكميات').getCell('B7').value, /خرسانة مسلحة/);
assert.equal(workbook.getWorksheet('حصر الكميات').getCell('E7').value, 12);
assert.equal(workbook.getWorksheet('حصر الكميات').getCell('E8').value.result, 12);
assert.equal(workbook.getWorksheet('حصر الكميات').getCell('I8').value.result, 12);
assert.doesNotMatch(workbook.getWorksheet('حصر الكميات').getCell('B7').value, /المصدر|صفحة 17 - بند 1/);
assert.equal(workbook.getWorksheet('حصر الكميات').columnCount, 10);
assert.equal(workbook.getWorksheet('حصر الكميات').getCell('J7').value, 'تفصيل');
assert.equal(workbook.getWorksheet('حصر الكميات').views[0].showGridLines, true);
assert.ok(workbook.getWorksheet('حصر الكميات').getColumn(2).width >= 'خرسانة مسلحة'.length + 2);
console.log('quantity takeoff tests passed');
