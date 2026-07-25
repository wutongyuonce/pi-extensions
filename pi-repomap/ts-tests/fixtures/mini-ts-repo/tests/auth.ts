import { AuthService, boot } from "../src/services/auth";

export function testBoot(): boolean {
  return boot(new AuthService());
}
