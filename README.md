# VaultSync - Secure Photo Backup

A secure, private photo backup system with a headless Node.js server and a React Native (Expo) mobile app.

## Features
- **Secure Auth**: Email/Password + Device UUID binding.
- **Encrypted Transport**: Designed for HTTPS (run behind Nginx/SSL in production).
- **Additive Sync**: Uploads only missing files; Downloads only missing files.
- **Private**: No frontend on the server to expose data.

## Prerequisites
- Node.js
- npm
- Expo Go app on your phone (or Android/iOS emulator)

## Setup & Run

### 1. Server (Backend)
The server handles storage and authentication.

```bash
cd server
npm install
npm start
```
Server runs on `http://localhost:3000`.
*Note: For physical device testing, ensure your computer and phone are on the same WiFi, and update `SERVER_URL` in `mobile/App.js` with your computer's local IP.*

### 2. Mobile App
The mobile app manages backups.

```bash
cd mobile
npm install
npx expo start
```
- Scan the QR code with Expo Go (Android) or Camera (iOS).

## Security Note
This system uses a "Device Binding" mechanism. A user token is valid ONLY for the device UUID it was issued to. This prevents stolen tokens from being used on other devices.
