export class AuthService {
  issue(): string {
    return "token";
  }
}

export const boot = (service: AuthService): boolean => service.issue() === "token";
