import ExcelJS from 'exceljs';

export async function buildQuantityTakeoffWorkbook(takeoff) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('حصر الكميات', { views: [{ rightToLeft: true, showGridLines: true }] });
  sheet.columns = [
    { key: 'index', width: 11 },
    { key: 'description', width: 52 },
    { key: 'location', width: 26 },
    { key: 'unit', width: 12 },
    { key: 'quantity', width: 14 },
    { key: 'reference', width: 24 },
    { key: 'previousQuantity', width: 14 },
    { key: 'currentQuantity', width: 14 },
    { key: 'executedQuantity', width: 14 },
    { key: 'notes', width: 34 },
  ];

  sheet.mergeCells('A1:J1');
  sheet.getCell('A1').value = 'حصر الكميات - بنود الأعمال';
  sheet.mergeCells('A2:J2');
  sheet.getCell('A2').value = `الملفات المصدر: ${takeoff.sourceFiles?.map(file => file.name).join('، ') || takeoff.sourceFile?.name || takeoff.title || 'مرفق'}`;
  sheet.mergeCells('A3:J3');
  sheet.getCell('A3').value = `تاريخ إعداد الحصر: ${new Date().toLocaleDateString('ar-LY')}`;
  sheet.mergeCells('A5:A6'); sheet.getCell('A5').value = 'رقم البند';
  sheet.mergeCells('B5:B6'); sheet.getCell('B5').value = 'بيان الأعمال';
  sheet.mergeCells('C5:C6'); sheet.getCell('C5').value = 'الموقع';
  sheet.mergeCells('D5:D6'); sheet.getCell('D5').value = 'الوحدة';
  sheet.mergeCells('E5:E6'); sheet.getCell('E5').value = 'الكمية';
  sheet.mergeCells('F5:F6'); sheet.getCell('F5').value = 'الصفحة/المرجع';
  sheet.mergeCells('G5:I5'); sheet.getCell('G5').value = 'الكميات المنفذة';
  sheet.getCell('G6').value = 'سابقة';
  sheet.getCell('H6').value = 'حالية';
  sheet.getCell('I6').value = 'إجمالي';
  sheet.mergeCells('J5:J6'); sheet.getCell('J5').value = 'ملاحظات';

  const titleStyle = { font: { bold: true, size: 16, color: { argb: 'FF0F172A' } }, alignment: { horizontal: 'center', vertical: 'middle', readingOrder: 2 } };
  const subTitleStyle = { font: { bold: true, size: 11, color: { argb: 'FF334155' } }, alignment: { horizontal: 'center', vertical: 'middle', readingOrder: 2 } };
  Object.assign(sheet.getCell('A1'), titleStyle);
  Object.assign(sheet.getCell('A2'), subTitleStyle);
  Object.assign(sheet.getCell('A3'), subTitleStyle);
  sheet.getRow(1).height = 30; sheet.getRow(2).height = 22; sheet.getRow(3).height = 22;

  const header = sheet.getRow(5);
  header.height = 25; sheet.getRow(6).height = 25;
  for (const rowNumber of [5, 6]) sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 2 };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  });

  takeoff.items.forEach((item, index) => {
    const description = [item.category, item.description].filter(Boolean).join('\n');
    const row = sheet.addRow({ index: index + 1, description, location: item.location, unit: item.unit, quantity: item.quantity, reference: item.reference, previousQuantity: 0, currentQuantity: item.quantity, executedQuantity: undefined, notes: item.notes });
    row.getCell(9).value = { formula: `SUM(G${row.number}:H${row.number})`, result: item.quantity };
    row.eachCell(cell => { cell.alignment = { vertical: 'middle', readingOrder: 2, wrapText: true }; });
    row.height = Math.max(24, Math.min(72, 18 + Math.ceil(description.length / 70) * 16));
    row.eachCell({ includeEmpty: true }, cell => { cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; });
    [5, 7, 8, 9].forEach(column => { row.getCell(column).numFmt = '#,##0.###'; });
  });

  const firstDataRow = 7, lastDataRow = Math.max(firstDataRow, sheet.lastRow.number);
  const totalRow = sheet.addRow({ description: 'إجمالي الكميات' });
  const totalQuantity = takeoff.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  totalRow.getCell(5).value = { formula: `SUM(E${firstDataRow}:E${lastDataRow})`, result: totalQuantity };
  totalRow.getCell(7).value = { formula: `SUM(G${firstDataRow}:G${lastDataRow})`, result: 0 };
  totalRow.getCell(8).value = { formula: `SUM(H${firstDataRow}:H${lastDataRow})`, result: totalQuantity };
  totalRow.getCell(9).value = { formula: `SUM(I${firstDataRow}:I${lastDataRow})`, result: totalQuantity };
  totalRow.font = { bold: true }; totalRow.height = 26;
  totalRow.eachCell({ includeEmpty: true }, cell => { cell.alignment = { vertical: 'middle', readingOrder: 2 }; cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });
  [5, 7, 8, 9].forEach(column => { totalRow.getCell(column).numFmt = '#,##0.###'; });
  sheet.getColumn(2).alignment = { wrapText: true, vertical: 'middle' };
  sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.2, right: 0.2, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
  sheet.printOptions = { horizontalCentered: true, verticalCentered: false };
  return workbook.xlsx.writeBuffer();
}
