import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "./config.js";

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function loadAndVerifyIccProfile({
  profilePath,
  expectedSha256,
  profileName
}) {
  const normalizedExpected = String(expectedSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedExpected)) {
    throw new Error("CMYK_ICC_SHA256 must be a 64-character SHA-256 digest.");
  }

  let profile;
  try {
    profile = fs.readFileSync(profilePath);
  } catch (error) {
    throw new Error(`Unable to read configured CMYK ICC profile: ${error.message}`);
  }

  const actualSha256 = sha256(profile);
  if (actualSha256 !== normalizedExpected) {
    throw new Error(
      `Configured CMYK ICC profile SHA-256 mismatch: expected ${normalizedExpected}, received ${actualSha256}.`
    );
  }

  return Object.freeze({
    name: String(profileName || "CMYK profile"),
    path: profilePath,
    sha256: actualSha256,
    bytes: profile.length
  });
}

// Importing the service performs this check before Express starts listening.
export const cmykProfile = loadAndVerifyIccProfile({
  profilePath: config.cmykIccProfile,
  expectedSha256: config.cmykIccSha256,
  profileName: config.cmykIccName
});
