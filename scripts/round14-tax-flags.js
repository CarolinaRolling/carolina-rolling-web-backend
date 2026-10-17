/**
 * Round 14 — estimates and open orders marked tax exempt whose client is NOT resale / exempt
 * (read-only report; changes nothing):
 *
 *   heroku run node scripts/round14-tax-flags.js            (or locally with DATABASE_URL set)
 *
 * Before round 14 the web app (and the estimate list / PDF on the server) treated "resale certificate
 * on file + active permit" as exempt and SAVED taxExempt = true on the estimate or order when it was
 * opened, even though the client's tax status was taxable. The invoice never used that rule. Those
 * saved flags stay until someone unticks them. This lists them so the office can check each one:
 * either set the client's tax status to Resale (if they really are) or untick "Tax exempt".
 */
const { sequelize } = require('../src/models');

(async () => {
  const q = async (sql) => (await sequelize.query(sql))[0];
  const clientJoin = (t) => `LEFT JOIN clients c ON c.id = ${t}."clientId" OR (${t}."clientId" IS NULL AND lower(trim(c.name)) = lower(trim(${t}."clientName")))`;
  const ests = await q(`SELECT e."estimateNumber" AS num, e."clientName" AS client, e.status, e."taxExemptReason" AS reason, c."taxStatus" AS "clientStatus",
      (c."resaleCertificate" IS NOT NULL AND c."permitStatus" = 'active') AS "certOnFile"
    FROM estimates e ${clientJoin('e')}
    WHERE e."taxExempt" = true AND COALESCE(c."taxStatus", '') NOT IN ('resale', 'exempt') AND e.status NOT IN ('converted', 'archived', 'declined')
    ORDER BY e."createdAt" DESC`);
  const wos = await q(`SELECT COALESCE('DR-' || w."drNumber", w."orderNumber") AS num, w."clientName" AS client, w."invoiceNumber" AS invoice, w."taxExemptReason" AS reason,
      c."taxStatus" AS "clientStatus", (c."resaleCertificate" IS NOT NULL AND c."permitStatus" = 'active') AS "certOnFile"
    FROM work_orders w ${clientJoin('w')}
    WHERE w."taxExempt" = true AND COALESCE(c."taxStatus", '') NOT IN ('resale', 'exempt') AND w."iifExportedAt" IS NULL AND COALESCE(w."isVoided", false) = false
    ORDER BY w."createdAt" DESC`);
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ estimates: ests, workOrders: wos }, null, 2)); }
  else {
    console.log(`${ests.length} open estimate(s) and ${wos.length} open order(s) are marked tax exempt, but their client is not Resale / Exempt:\n`);
    for (const r of ests) console.log(`  estimate ${String(r.num).padEnd(16)} ${String(r.client || '').slice(0, 30).padEnd(30)} client: ${r.clientStatus || '(no client record)'}${r.certOnFile ? ', cert + active permit on file' : ''}  reason: ${r.reason || ''}`);
    for (const r of wos) console.log(`  order    ${String(r.num).padEnd(16)} ${String(r.client || '').slice(0, 30).padEnd(30)} client: ${r.clientStatus || '(no client record)'}${r.certOnFile ? ', cert + active permit on file' : ''}  inv ${r.invoice || ''}  reason: ${r.reason || ''}`);
    console.log('\nFor each: if the client really buys for resale, set the client\'s tax status to Resale; otherwise untick "Tax exempt".');
  }
  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
