export interface SecretCipher {
  /**
   * 加密凭据。
   * @param value - 明文凭据。
   */
  encrypt(value: string): Buffer
  /** 解密凭据。 */
  decrypt(value: Buffer): string
}
