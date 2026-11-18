package dev.boujoy.personalagent;
import org.junit.Test;
import static org.junit.Assert.*;
public class ImagePreviewsTest {
 @Test public void oldDeliveredVideosWithGenericMimeStillOfferPreview(){
  assertEquals("video/webm",ImagePreviews.mime(Tunnel.json("name","clip.WEBM","mime","application/octet-stream")));
  assertEquals("video/mp4",ImagePreviews.mime(Tunnel.json("name","clip.m4v")));
  assertEquals("video/quicktime",ImagePreviews.mime(Tunnel.json("name","clip.mov")));
  assertEquals("video/custom",ImagePreviews.mime(Tunnel.json("name","clip.mp4","mime","video/custom")));
  assertEquals("application/octet-stream",ImagePreviews.mime(Tunnel.json("name","clip.webm.exe","mime","application/octet-stream")));
 }
}
