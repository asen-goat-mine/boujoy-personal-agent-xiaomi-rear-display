package dev.boujoy.personalagent;

import android.graphics.Typeface;
import android.graphics.Paint;
import android.text.style.LineHeightSpan;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Local inline formatting for assistant replies; never interprets HTML or links. */
final class ChatText {
    private static final Pattern INLINE=Pattern.compile("(?s)```.*?(?:```|\\z)|`[^`\\n]+`|\\*\\*[^\\n]+?\\*\\*");
    static CharSequence assistant(String source) {return assistant(source,-1);}
    static CharSequence assistant(String source,int blankLineHeight) {
        if(source==null)return "";
        SpannableStringBuilder result=new SpannableStringBuilder();
        Matcher match=INLINE.matcher(source);int offset=0;
        while(match.find()) {
            // Keep escaped markers literal, and keep formatting inside code literal.
            if(match.start()>0&&source.charAt(match.start()-1)=='\\')continue;
            result.append(source,offset,match.start());
            String token=match.group();if(token.startsWith("```")){int newline=token.indexOf('\n');int begin=newline>=0?newline+1:3;int end=token.endsWith("```")&&token.length()>3?token.length()-3:token.length();int start=result.length();result.append(token,Math.min(begin,end),end);result.setSpan(new TypefaceSpan("monospace"),start,result.length(),Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);offset=match.end();continue;}boolean code=token.charAt(0)=='`';int trim=code?1:2;
            int start=result.length();result.append(token,trim,token.length()-trim);
            result.setSpan(code?new TypefaceSpan("monospace"):new StyleSpan(Typeface.BOLD),start,result.length(),Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            offset=match.end();
        }
        result.append(source,offset,source.length());
        if(blankLineHeight>=0&&!source.contains("```")) {
            String plain=result.toString();int at=0;
            while((at=plain.indexOf("\n\n",at))>=0) {
                result.setSpan(new ParagraphGap(blankLineHeight),at+1,at+2,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);at+=2;
            }
        }
        return result;
    }
    private static final class ParagraphGap implements LineHeightSpan {
        private final int height;
        ParagraphGap(int height){this.height=height;}
        @Override public void chooseHeight(CharSequence text,int start,int end,int spanStart,int top,Paint.FontMetricsInt metrics){metrics.top=0;metrics.ascent=0;metrics.descent=height;metrics.bottom=height;}
    }
    private ChatText(){}
}
