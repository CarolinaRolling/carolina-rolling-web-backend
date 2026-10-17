/**
 * safeRender — open a Chrome page for turning OUR html into a PDF without letting that html reach
 * anything (round 12, audit N9).
 *
 * The html comes from the browser (the WPS generator, the work-order print package) and contains text
 * users and scanned e-mails control. Before, Chrome ran it with JavaScript on and full network access,
 * so a crafted note could make the server fetch internal addresses (cloud metadata, localhost admin
 * ports) into a PDF. Now JavaScript is off and every request is refused except inline data, and
 * images from our own file storage (S3 bucket, Cloudinary).
 */
function allowedUrl(u) {
  if (/^(data|about|blob):/i.test(u)) return true;
  let url; try { url = new URL(u); } catch (_) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const bucket = String(process.env.AWS_S3_BUCKET || '').toLowerCase();
  if (bucket && (host === `${bucket}.s3.amazonaws.com` || (host.startsWith(`${bucket}.s3.`) && host.endsWith('.amazonaws.com')))) return true;
  if (host === 'res.cloudinary.com') return true;
  return false;
}

async function safePage(browser) {
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    try { if (allowedUrl(r.url())) r.continue(); else r.abort('blockedbyclient'); } catch (_) { /* already handled */ }
  });
  return page;
}

module.exports = { safePage, allowedUrl };
