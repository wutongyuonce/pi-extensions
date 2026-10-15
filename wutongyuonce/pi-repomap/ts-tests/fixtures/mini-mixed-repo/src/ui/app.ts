export class AppShell {
  ready(): boolean {
    return true;
  }
}

export const boot = (app: AppShell): boolean => app.ready();
