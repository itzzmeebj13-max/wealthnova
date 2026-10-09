import { registerBodyMobileNumberRegExp } from "./generated/api";

export const PHILIPPINE_MOBILE_VALIDATION_MESSAGE =
  "Please enter a valid Philippine mobile number.";

export function normalizePhilippineMobileNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const input = value.trim();
  if (!registerBodyMobileNumberRegExp.test(input)) return null;

  if (input.startsWith("09")) return `+63${input.slice(1)}`;
  if (input.startsWith("639")) return `+${input}`;
  return input;
}

export function isValidPhilippineMobileNumber(value: unknown): boolean {
  return normalizePhilippineMobileNumber(value) !== null;
}

export function getPhilippineMobileNumberCandidates(value: string): string[] {
  const normalized = normalizePhilippineMobileNumber(value);
  if (!normalized) return [];

  return [
    normalized,
    `0${normalized.slice(3)}`,
    normalized.slice(1),
  ];
}
