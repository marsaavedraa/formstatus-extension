# FormStatus Chrome Extension

Chrome extension for FormStatus - Monitor and check your web forms status directly from your browser.

## Features

- **Login to FormStatus**: Sign in with your FormStatus account credentials
- **Session Management**: Maintains authentication state across browser sessions
- **Form Monitoring**: Detects and monitors forms on web pages (when logged in)
- **Dashboard Access**: Quick access to your FormStatus dashboard
- **Badge Indicator**: Shows connection status in the extension badge

## Installation

### Development Mode

1. Clone or download this extension folder
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the `chrome-extension` folder

## Configuration

### API Base URL

By default, the extension connects to the local development server:

```javascript
const API_BASE_URL = 'http://localhost:8080';
```

For production, update this in `background.js`:

```javascript
const API_BASE_URL = 'https://app.formstatus.co';
```

## File Structure

```
chrome-extension/
├── manifest.json       # Extension configuration
├── background.js       # Service worker for auth management
├── popup.html         # Login popup UI
├── popup.css          # Popup styling
├── popup.js           # Popup logic
├── content.js         # Form monitoring script
└── icons/             # Extension icons
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    ├── icon128.png
    └── icon.svg
```

## How It Works

### Authentication Flow

1. User enters email/password in the popup
2. Extension sends credentials to the background script
3. Background script:
   - Fetches CSRF token from Laravel
   - Posts to `/login` endpoint with credentials
   - Fetches user data from `/api/user`
   - Stores auth state in `chrome.storage.local`
4. Cookies are stored automatically by the browser

### Session Management

- Extension verifies session validity every 30 minutes
- On browser startup, checks existing auth state
- Logout clears cookies and storage

### Form Monitoring

The content script (`content.js`) runs on all web pages and:

- Detects all forms on the page
- Monitors form submissions
- Tracks user interactions (optional)
- Only active when user is logged in

## API Integration

The extension integrates with FormStatus Laravel app endpoints:

- `GET /sanctum/csrf-cookie` - CSRF token
- `POST /login` - User authentication
- `GET /api/user` - Get current user
- `POST /logout` - User logout

## Development

### Testing Login

1. Make sure your FormStatus app is running (`php artisan serve`)
2. Load the extension in Chrome
3. Click the extension icon
4. Enter your FormStatus credentials
5. You should see the dashboard view with your user info

### Debugging

Open the browser console to see logs from:
- **Popup**: Right-click popup → Inspect
- **Background**: `chrome://extensions/` → Service worker → inspect
- **Content Script**: Regular DevTools console on any webpage

## Permissions

The extension requires:
- `storage` - Save authentication state
- `cookies` - Manage session cookies
- `activeTab` - Access current tab for form monitoring
- `alarms` - Periodic auth checks
- Host permissions for FormStatus domains

## Building for Production

1. Update `API_BASE_URL` in `background.js` to production URL
2. Test thoroughly with production backend
3. Consider zipping the extension for Chrome Web Store distribution

## Chrome Web Store Submission

To publish to the Chrome Web Store:

1. Create a developer account at https://chrome.google.com/webstore/developer/dashboard
2. Prepare assets:
   - Screenshots (1280x800 or 640x400)
   - Promotional tiles
   - Detailed description
3. Zip the extension folder
4. Upload and submit for review

## Icons

Current icons are placeholders. To create better icons:

1. Edit `icons/icon.svg` with your design
2. Convert to PNG sizes: 16, 32, 48, 128
3. Use ImageMagick or online tools like CloudConvert

```bash
convert -background none -resize 16x16 icon.svg icon16.png
convert -background none -resize 32x32 icon.svg icon32.png
convert -background none -resize 48x48 icon.svg icon48.png
convert -background none -resize 128x128 icon.svg icon128.png
```

## Security Notes

- Credentials are sent directly to FormStatus API (no intermediate servers)
- Session cookies are stored by Chrome's cookie system
- Extension uses HTTPS for production endpoints
- Sensitive form fields (passwords, credit cards) are not tracked
