package dev.boujoy.personalagent;

import android.text.InputType;
import org.junit.Test;
import static org.junit.Assert.*;

public class TypingPolicyTest {
    @Test public void wirelessInputRequiresTheSameWritableEditor() {
        String chat = "com.tencent.mm", assistant = "dev.boujoy.personalagent";
        assertTrue("WeChat editors are writable like any other app", TypingPolicy.writableEditor(chat, chat));
        assertFalse(TypingPolicy.writableEditor(assistant, chat));
        assertFalse(TypingPolicy.writableEditor(chat, assistant));
        assertFalse(TypingPolicy.writableEditor(assistant, null));
        assertTrue(TypingPolicy.writableEditor(assistant, assistant));
        assertTrue(TypingPolicy.writableEditor("com.tencent.mobileqq", "com.tencent.mobileqq"));
    }
    @Test public void passwordFieldsAreNeverTyped() {
        assertTrue(TypingPolicy.password(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD));
        assertTrue(TypingPolicy.password(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD));
        assertTrue(TypingPolicy.password(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD));
        assertTrue(TypingPolicy.password(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD));
        assertFalse(TypingPolicy.password(InputType.TYPE_CLASS_TEXT));
        assertFalse(TypingPolicy.password(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS));
        assertFalse(TypingPolicy.password(InputType.TYPE_CLASS_NUMBER));
    }
    @Test public void onlyOrdinaryTextInEitherInputModeIsAccepted() {
        assertTrue(TypingPolicy.textAllowed("猪脚饭", "replace"));
        assertTrue(TypingPolicy.textAllowed("你好\n第二行", "insert"));
        assertFalse(TypingPolicy.textAllowed("", "insert"));
        assertFalse(TypingPolicy.textAllowed("x".repeat(2001), "insert"));
        assertFalse(TypingPolicy.textAllowed("你好", "append"));
        assertFalse(TypingPolicy.textAllowed("a\u0000b", "insert"));
    }
}
