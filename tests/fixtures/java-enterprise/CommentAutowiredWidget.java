package com.example.orders;

public class CommentAutowiredWidget {
    // Old field injection used to look like this: @Autowired private WidgetGateway gateway;
    // Left here as documentation only — no real annotation, no real field.
    private int renderCount;

    public void render() {
        renderCount++;
    }

    public int renderCount() {
        return renderCount;
    }
}
