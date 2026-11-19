// Turns a short-lived Meta user token into never-expiring Page tokens and finds the linked Instagram account.
// Usage: npm run meta:setup -- <APP_ID> <APP_SECRET> <SHORT_LIVED_USER_TOKEN>
const [appId, appSecret, shortToken] = process.argv.slice(2);
const version = process.env.META_GRAPH_VERSION || 'v23.0';
const G = `https://graph.facebook.com/${version}`;

if (!appId || !appSecret || !shortToken) {
  console.log('Usage: npm run meta:setup -- <APP_ID> <APP_SECRET> <SHORT_LIVED_USER_TOKEN>');
  console.log('Get the user token from the Graph API Explorer with these permissions:');
  console.log('  pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management');
  process.exit(1);
}

async function get(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}

try {
  const q = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken });
  const { access_token: longUser } = await get(`${G}/oauth/access_token?${q}`);
  const pages = await get(`${G}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(longUser)}`);
  if (!pages.data?.length) {
    console.log('No Pages found. Make sure you granted access to your Page when creating the token.');
    process.exit(1);
  }
  for (const p of pages.data) {
    const ig = p.instagram_business_account;
    console.log(`\n# ${p.name}${ig ? `  (Instagram: @${ig.username})` : '  (no Instagram business/creator account linked)'}`);
    console.log(`FACEBOOK_PAGE_ID=${p.id}`);
    console.log(`FACEBOOK_PAGE_ACCESS_TOKEN=${p.access_token}`);
    if (ig) console.log(`INSTAGRAM_USER_ID=${ig.id}`);
  }
  console.log('\nCopy the block for your Page into .env. These Page tokens do not expire unless you change your password or remove the app.');
} catch (err) {
  console.error('Meta setup failed:', err.message);
  process.exit(1);
}
