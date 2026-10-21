/** Shorten a wallet address while keeping enough characters to tell accounts apart. */
export function truncateAddress(address: string, head = 8, tail = 8): string {
  if (address.length <= head + tail + 3) return address
  return `${address.slice(0, head)}...${address.slice(-tail)}`
}
