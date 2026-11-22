export interface SecretCipher {
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
