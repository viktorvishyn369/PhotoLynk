const crypto = require('crypto');

const args = process.argv.slice(2);
// Default to localhost, or pass your local IP like http://192.168.1.5:3000
const serverUrl = args[0] || 'http://localhost:3000';
const email = (args[1] || 'migration_test@example.com').toLowerCase().trim();
const password = args[2] || 'testpass123';

// Generate UUIDv5 exactly like the app does (DNS namespace + email:password)
function uuidv5(name, namespace) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(nsBytes).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC4122
  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const deviceUuid = uuidv5(`${email}:${password}`, DNS_NAMESPACE);

async function registerLegacyUser() {
  console.log(`🚀 Registering legacy user on ${serverUrl}...`);
  console.log(`   Email:    ${email}`);
  console.log(`   Password: ${password}`);
  console.log(`   Device ID: ${deviceUuid}\n`);

  try {
    const response = await fetch(`${serverUrl}/api/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        password: password,
        device_uuid: deviceUuid,
        deviceUuid: deviceUuid,
        device_name: 'Test Registration Script',
        plan_gb: 100
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      console.log('✅ Success! User created.');
      console.log('User ID:', data.userId);
      console.log('Token:', data.token.substring(0, 20) + '...');
      console.log('\n👉 You can now open the app, tap "Connect Wallet", and use the "Link Existing Account" flow with this email and password.');
    } else {
      console.log(`❌ Failed! (Status: ${response.status})`);
      console.log('Error:', data.error || data);
      
      if (response.status === 409) {
        console.log('\n💡 This user already exists. You can use it for migration testing right away.');
      }
    }
  } catch (error) {
    console.error('❌ Network error:', error.message);
    console.log('Make sure your backend server is running and the URL is correct.');
  }
}

registerLegacyUser();
