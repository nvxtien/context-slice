package com.example.orders;

public class PlainUtilWithCommentAnnotation {
    private int callCount;

    // example usage elsewhere: @RequestMapping("/fake") is not a real mapping here
    public void recordCall() {
        callCount++;
    }

    public int callCount() {
        return callCount;
    }
}
