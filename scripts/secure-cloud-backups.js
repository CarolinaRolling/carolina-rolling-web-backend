/**
 * One-time: make existing database backups on Cloudinary private (audit C3).
 *
 * Backups used to be uploaded as PUBLIC raw files named shipment-tracker-backups/backup-<timestamp>.
 * Anyone who knew the Cloudinary cloud name could guess those URLs and download the full database.
 * New backups are uploaded as "authenticated" (signed-URL only). This converts the old ones.
 *
 *   heroku run node scripts/secure-cloud-backups.js            # dry run: list what would change
 *   heroku run node scripts/secure-cloud-backups.js --apply    # convert them
 *
 * Because the old files were public, also rotate: user passwords (or at least admin), every API
 * key, the JWT_SECRET, and reconnect the Gmail accounts so their stored tokens are replaced.
 */
require('dotenv').config();
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

(async () => {
  const apply = process.argv.includes('--apply');
  if (!process.env.CLOUDINARY_CLOUD_NAME) { console.error('CLOUDINARY_* env vars are not set.'); process.exit(2); }

  const found = [];
  let cursor;
  do {
    let q = cloudinary.search.expression('folder:shipment-tracker-backups AND resource_type:raw').max_results(100);
    if (cursor) q = q.next_cursor(cursor);
    const r = await q.execute();
    found.push(...(r.resources || []));
    cursor = r.next_cursor;
  } while (cursor);

  const publicOnes = found.filter(r => r.type === 'upload');
  console.log(`${found.length} backup file(s) found; ${publicOnes.length} are public.`);
  for (const r of publicOnes) console.log(`  public: ${r.public_id}  (${r.created_at}, ${Math.round(r.bytes / 1024)} KB)`);
  if (!apply) { console.log('\nDry run. Re-run with --apply to make them private.'); return; }

  let ok = 0;
  for (const r of publicOnes) {
    try {
      await cloudinary.uploader.rename(r.public_id, r.public_id, { resource_type: 'raw', type: 'upload', to_type: 'authenticated', invalidate: true });
      ok++;
      console.log(`  made private: ${r.public_id}`);
    } catch (e) {
      console.error(`  FAILED ${r.public_id}: ${e.message || JSON.stringify(e)}`);
    }
  }
  console.log(`\n${ok} of ${publicOnes.length} converted. Now rotate the secrets listed at the top of this file.`);
})().catch(e => { console.error(e); process.exit(1); });
