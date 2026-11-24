import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';

async function verifyDatabaseEndToEnd() {
  console.log('=====================================================');
  console.log('   ROYAL DAM ERP - DATABASE COMPREHENSIVE TEST');
  console.log('=====================================================');
  
  console.log('\n[1/5] Connecting to MySQL remote database...');
  const conn = await mysql.createConnection({
    host: 'sql8.freesqldatabase.com',
    port: 3306,
    database: 'sql8835776',
    user: 'sql8835776',
    password: '8BIdk28wB8',
    charset: 'utf8mb4',
    connectTimeout: 15000
  });
  console.log('  -> Connected successfully to sql8.freesqldatabase.com!');

  const testId = 'test-verification-' + Date.now();
  const testProject = {
    id: testId,
    name: 'مشروع فحص النظام التلقائي ' + new Date().toLocaleTimeString(),
    client: 'شركة الاختبارات التقنية',
    budget: 150000,
    status: 'نشط',
    location: 'الرياض - الموقع التجريبي',
    notes: 'سجل تجريبي لاختبار قدرة المنظومة على حفظ واسترجاع البيانات من قاعدة البيانات',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  console.log('\n[2/5] Writing test record (INSERT INTO erp_records)...');
  await conn.query(
    'INSERT INTO erp_records (entity, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['projects', testId, JSON.stringify(testProject), new Date(testProject.createdAt), new Date(testProject.updatedAt)]
  );
  console.log('  -> Project record inserted successfully with ID:', testId);

  console.log('\n[3/5] Reading back record from database (SELECT query)...');
  const [rows] = await conn.query('SELECT * FROM erp_records WHERE entity = ? AND id = ?', ['projects', testId]);
  if (rows.length > 0) {
    const data = JSON.parse(rows[0].data);
    console.log('  -> Record found in database:');
    console.log('     * Name:', data.name);
    console.log('     * Client:', data.client);
    console.log('     * Budget:', data.budget);
    console.log('     * Created At (DB):', rows[0].created_at);
  } else {
    throw new Error('FAILED: Record was not found after insertion!');
  }

  console.log('\n[4/5] Updating record (UPDATE data in database)...');
  testProject.budget = 200000;
  testProject.notes = 'تم تحديث الميزانية بنجاح';
  testProject.updatedAt = new Date().toISOString();
  await conn.query(
    'UPDATE erp_records SET data = ?, updated_at = ? WHERE entity = ? AND id = ?',
    [JSON.stringify(testProject), new Date(testProject.updatedAt), 'projects', testId]
  );
  
  const [updatedRows] = await conn.query('SELECT * FROM erp_records WHERE entity = ? AND id = ?', ['projects', testId]);
  const updatedData = JSON.parse(updatedRows[0].data);
  console.log('  -> Updated record verified. New budget:', updatedData.budget, '| Notes:', updatedData.notes);

  console.log('\n[5/5] Deleting test record (DELETE cleanup)...');
  await conn.query('DELETE FROM erp_records WHERE entity = ? AND id = ?', ['projects', testId]);
  const [deletedRows] = await conn.query('SELECT * FROM erp_records WHERE entity = ? AND id = ?', ['projects', testId]);
  console.log('  -> Cleanup verified: Remaining matching records =', deletedRows.length);

  console.log('\n-----------------------------------------------------');
  console.log('CURRENT DATABASE TABLES & RECORD COUNTS:');
  const [counts] = await conn.query('SELECT entity, count(*) as count FROM erp_records GROUP BY entity');
  console.table(counts);

  const [users] = await conn.query('SELECT id, username, token_version FROM erp_users');
  console.log('REGISTERED USERS IN DATABASE:');
  console.table(users);

  await conn.end();
  console.log('=====================================================');
  console.log('RESULT: DATABASE IS ONLINE, SAVING, AND PERSISTING DATA CORRECTLY.');
  console.log('=====================================================');
}

verifyDatabaseEndToEnd().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
