package dev.boujoy.personalagent;
import java.util.*;

/** Pixel reading offset stays attached to a stable message key. Viewport excludes scroll padding. */
public record ChatScrollAnchor(String key,int offset,int oldY,boolean followBottom) {
    public record Item(String key,int top,int bottom) {}
    public static boolean nearBottom(int y,int contentHeight,int viewportHeight,int threshold){
        return maximum(contentHeight,viewportHeight)-y<=Math.max(0,threshold);
    }
    private static int maximum(int contentHeight,int viewportHeight){return Math.max(0,contentHeight-Math.max(0,viewportHeight));}
    public static ChatScrollAnchor capture(List<Item> items,int y,int contentHeight,int viewportHeight,int threshold){
        boolean follow=items.isEmpty()||nearBottom(y,contentHeight,viewportHeight,threshold);
        for(Item item:items)if(item.bottom()>y)return new ChatScrollAnchor(item.key(),y-item.top(),y,follow);
        return new ChatScrollAnchor(null,0,y,follow);
    }
    public int restore(List<Item> items,int contentHeight,int viewportHeight){
        int maximum=maximum(contentHeight,viewportHeight);if(followBottom)return maximum;
        for(Item item:items)if(Objects.equals(key,item.key()))return Math.max(0,Math.min(maximum,item.top()+offset));
        return Math.max(0,Math.min(maximum,oldY));
    }
}
