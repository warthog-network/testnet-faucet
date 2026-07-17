// src/qr.js
// Server-side QR rendering using the `qrcode` npm dep. Used by the landing
// page to embed a QR for the faucet's own WART address.

import QRCode from "qrcode";

export async function toDataUrl(text, opts = {}) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 192,
    ...opts,
  });
}
