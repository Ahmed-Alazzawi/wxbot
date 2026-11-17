/**
 * Verifies that an incoming request was really sent by Discord.
 *
 * Discord signs every request with its private key (Ed25519). We check the
 * signature with our app's Public Key. Anyone can find the Worker's URL, so
 * without this check anyone could send fake commands. Discord also tests this
 * with deliberately bad signatures and refuses the endpoint if we accept them.
 */

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyDiscordRequest(
  request: Request,
  body: string,
  publicKeyHex: string,
): Promise<boolean> {
  const signatureHex = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signatureHex || !timestamp || !publicKeyHex) return false;

  const signature = hexToBytes(signatureHex);
  const publicKey = hexToBytes(publicKeyHex);
  if (!signature || !publicKey || signature.length !== 64 || publicKey.length !== 32) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
      "verify",
    ]);
    // The signed message is the timestamp followed by the raw body.
    const signed = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signed);
  } catch {
    return false;
  }
}
