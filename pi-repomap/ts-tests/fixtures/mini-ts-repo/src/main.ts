import { AuthService, boot } from "./services/auth";

export function main(): boolean {
  const service = new AuthService();
  return boot(service);
}
