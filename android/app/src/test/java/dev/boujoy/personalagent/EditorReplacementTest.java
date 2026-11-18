package dev.boujoy.personalagent;
import org.junit.Test;
import static org.junit.Assert.*;

public class EditorReplacementTest {
    static final class Editor implements EditorReplacement.Selection {
        String text; int start, end; final int[] range; boolean all;
        Editor(String value, int[] range) { text=value; this.range=range; start=end=value.length(); }
        public int[] surroundingRange() { return range; }
        public void select(int a,int b) { start=a;end=b; }
        public void selectAll() { all=true;start=0;end=text.length(); }
        void commit(String next) { text=text.substring(0,start)+next+text.substring(end); }
    }
    @Test public void customEditorWithNoReadableSurroundingTextStillReplacesOldDraft() {
        Editor e=new Editor("旧的搜索词和草稿",null);EditorReplacement.prepare(e);e.commit("新的内容");assertEquals("新的内容",e.text);assertTrue(e.all);
    }
    @Test public void truncatedOrOffsetTextMustNotLeaveAnyOldPrefixOrSuffix() {
        for(int[] range:new int[][]{new int[]{12,20},new int[]{0,4000},new int[]{-1,4}}){Editor e=new Editor("old prefix and suffix",range);EditorReplacement.prepare(e);e.commit("你好");assertEquals("你好",e.text);assertTrue(e.all);}
    }
    @Test public void ordinaryCompleteTextUsesItsActualSelectionAndEmptyEditorWorks() {
        for(String old:new String[]{"", "already typed"}){Editor e=new Editor(old,new int[]{0,old.length()});EditorReplacement.prepare(e);e.commit("你好");assertEquals("你好",e.text);assertFalse(e.all);}
    }
}
