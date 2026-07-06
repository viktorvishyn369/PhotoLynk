# PhotoLynk File Recovery Guide

This guide explains how to recover your PhotoLynk encrypted files if your phone is lost, damaged, or the app stops working.

---

## Method 1: The Easy Way — Install PhotoLynk on a New Phone

**This is the recommended method. No scripts, no technical knowledge needed.**

### What You Need
- A new Android phone (Solana Mobile or any Android with MWA support)
- The **same wallet** you used on your old phone
- An internet connection

### Steps

1. **Install PhotoLynk** from the Google Play Store or your backup APK.
2. **Open the app** and tap **"Connect Wallet"**.
3. **Select your wallet** (Seed Vault, Phantom, Backpack, etc.).
4. **Sign the derivation message** when prompted. This is the message that creates your encryption key. It is safe to sign — it never sends anything to the server.
5. **Wait a moment.** Your files will start appearing automatically. Both new files (encrypted with the secure key) and older files (encrypted with the previous key) work seamlessly.

### Why This Works
Your encryption key is derived from your wallet signature. The same wallet + the same message = the same key, every time. It does not matter which wallet app you use (Jito, Phantom, Seed Vault, etc.) — as long as it's the same private key, the signature is identical.

### What If the App Doesn't Auto-Decrypt?
In the rare case that some files don't appear, check that:
- You are using the **same wallet** (same seed phrase / private key)
- You are connected to the **same server** (check Settings → Server)

If files are still missing, contact support. You do **not** need to save your Secure Key for normal recovery — the same wallet regenerates it automatically.

---

## Method 2: Self-Service Recovery on a PC (No Solana Phone Needed)

**Use this if you lost your phone and don't have access to another Android device with a Solana wallet, or if you prefer to recover files on your computer.**

**You do NOT need to save your Secure Key for Method 1.** The same wallet on any phone regenerates the key automatically. The key below is only needed if you want to recover files on a PC without a Solana phone.

### What You Need
- A computer with **Node.js** installed (version 18 or newer)
- Your **Secure Key** (and Previous Key, if you have older files)
- Your **email** and **password** that you use to log in to PhotoLynk
- Your **device UUID** (found in Settings → About → Device ID)

### Step 1: Get Your Keys

1. Open PhotoLynk on your old phone (or a friend's phone with your account).
2. Go to **Settings → Encryption & Recovery**.
3. Tap **"Reveal Encryption Key(s)"**.
4. Copy the **Secure Key** (long base64 string starting with letters/numbers).
5. If you see a **Previous Key**, copy that too.

### Step 2: Get Your Device UUID

1. In PhotoLynk, go to **Settings → About**.
2. Find **Device ID** (a long string of letters and numbers).
3. Copy it.

### Step 3: Install the Recovery Script

Open a terminal on your computer and run:

```bash
# Clone or download the PhotoLynk repository
cd /path/to/photolynk/server/scripts

# Install dependencies (only need axios for HTTP requests)
npm install axios
```

### Step 4: Run the Recovery Script

The script is at `photolynk-recover.js`. You run it like this:

```bash
node photolynk-recover.js \
  --email your-email@example.com \
  --password your-password \
  --device-uuid YOUR_DEVICE_UUID \
  --master-key YOUR_SECURE_KEY \
  --server https://stealthlynk.io \
  --out ./recovered_files
```

#### If you also have a Previous Key (for older files):

```bash
node photolynk-recover.js \
  --email your-email@example.com \
  --password your-password \
  --device-uuid YOUR_DEVICE_UUID \
  --master-key YOUR_SECURE_KEY \
  --legacy-master-key YOUR_PREVIOUS_KEY \
  --server https://stealthlynk.io \
  --out ./recovered_files
```

### What the Script Does

1. **Logs in** to the server with your email and password.
2. **Fetches all your file manifests** (the list of files you backed up).
3. **Tries to decrypt each manifest**:
   - First with the Secure Key
   - If that fails, tries the Previous Key (dual-key fallback)
4. **Downloads each file chunk** from the server.
5. **Decrypts and reassembles** the original files.
6. **Saves them** to the `--out` folder on your computer.

### Script Options

| Option | Required? | Description |
|--------|-----------|-------------|
| `--email` | Yes | Your PhotoLynk login email |
| `--password` | Yes | Your PhotoLynk login password |
| `--device-uuid` | Yes | Your device UUID from Settings |
| `--master-key` | Yes | Your Secure Key (base64) |
| `--legacy-master-key` | No | Your Previous Key (base64), only if you have older files |
| `--server` | No | Server URL (default: https://stealthlynk.io) |
| `--out` | No | Output folder (default: ./recovered) |

### Troubleshooting

**"Authentication failed"**
- Double-check your email and password.
- Make sure the `--device-uuid` matches exactly (copy-paste, no extra spaces).

**"Decryption failed"**
- Make sure you copied the Secure Key correctly (it should be a long base64 string).
- If you have older files, also provide `--legacy-master-key`.

**"Server not found"**
- Check the `--server` URL. If you use a custom server, use that URL instead.

---

## Security Notes

- **Your wallet private key never leaves your phone.** The recovery script only uses the derived encryption key, not your wallet seed phrase or private key.
- **The admin recovery script never learns your wallet private key.** If you ask support for help, you only provide the Secure Key. The admin cannot derive your wallet private key from this key.
- **Keep your Secure Key safe.** Anyone with your Secure Key can decrypt your files if they also have your login credentials. Store it in a password manager or write it down and keep it in a safe place.
- **The Previous Key** only appears if you have older files from before the encryption upgrade. It is shown during the migration and disappears once all files are re-encrypted with the Secure Key.

---

## FAQ

**Q: Do I need to save my Secure Key?**
A: Not for normal recovery. The same wallet on any Solana phone regenerates the key automatically. Only save it if you want a backup for PC recovery (Method 2) in case you ever lose access to a Solana phone.

**Q: Can I recover without my wallet?**
A: Only via Method 2 (the script on a PC). You need your Secure Key + login credentials. The script decrypts files without needing the wallet.

**Q: Can I recover on an iPhone?**
A: Method 1 requires an Android phone with a Solana wallet. For iPhone or any non-Android device, use Method 2 (recovery script on a computer) with your Secure Key.

**Q: What if I lost my phone but still have my wallet?**
A: Install PhotoLynk on any Android phone, connect the same wallet, and your files appear automatically. The key is regenerated from your wallet signature — no backup needed.

**Q: What if I lost both my phone and my wallet?**
A: If you saved your Secure Key, you can still recover via Method 2 (PC script). If you lost both your phone and your wallet (seed phrase) AND did not save your Secure Key, recovery is not possible — this is by design for your privacy.

**Q: Does the server store my files unencrypted?**
A: No. The server only stores encrypted chunks. The server cannot decrypt your files without your key.

**Q: Who can see my files?**
A: Only you. Your files are encrypted before they leave your phone. The server only sees encrypted data.
