import lombok.Getter;

class App {
    @Getter
    private final String name = "pi-lens";

    static String readName() {
        return new App().getName();
    }
}
