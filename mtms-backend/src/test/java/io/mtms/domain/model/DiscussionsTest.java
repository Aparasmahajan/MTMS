package io.mtms.domain.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * Who a comment names.
 *
 * <p>Small rules with a sharp failure: a mention that resolves to the wrong person tells the
 * wrong person, and one that resolves to nobody silently drops the only thing that was going to
 * make somebody read the comment. Both are invisible until they matter.
 */
@DisplayName("mentions in a comment")
class DiscussionsTest {

  private static final UUID PARAS = UUID.randomUUID();
  private static final UUID PARAS_M = UUID.randomUUID();
  private static final UUID VINAYAK = UUID.randomUUID();

  /** The organisation, as handles: display name and the local part of the address. */
  private static List<Discussions.Candidate> people() {
    List<Discussions.Candidate> all = new ArrayList<>();
    all.addAll(Discussions.candidatesFor(PARAS, "Paras", "paras@azalio.io"));
    all.addAll(Discussions.candidatesFor(PARAS_M, "Paras Mahajan", "paras.mahajan@azalio.io"));
    all.addAll(Discussions.candidatesFor(VINAYAK, "Vinayak", "vinayak@azalio.io"));
    return all;
  }

  @Nested
  @DisplayName("matching")
  class Matching {

    @Test
    @DisplayName("a name is matched")
    void byDisplayName() {
      assertEquals(Set.of(VINAYAK), Discussions.mentionedIn("@Vinayak can you check this", people()));
    }

    @Test
    @DisplayName("an address is matched too, because that is what people type")
    void byEmailLocalPart() {
      assertEquals(
          Set.of(PARAS_M),
          Discussions.mentionedIn("asked @paras.mahajan yesterday", people()));
    }

    @Test
    @DisplayName("case does not matter")
    void caseInsensitive() {
      assertEquals(Set.of(VINAYAK), Discussions.mentionedIn("@VINAYAK", people()));
    }

    @Test
    @DisplayName("the longest handle wins, so @paras.mahajan is not read as @paras")
    void longestHandleWins() {
      // The failure this prevents: telling the wrong Paras, or both of them, every time
      // somebody writes the fuller handle.
      Set<UUID> found = Discussions.mentionedIn("@paras.mahajan please confirm", people());

      assertEquals(Set.of(PARAS_M), found);
      assertTrue(!found.contains(PARAS), "the shorter handle should not also match");
    }

    @Test
    @DisplayName("a handle has to end where it ends — @dev does not match @devops")
    void respectsWordBoundary() {
      List<Discussions.Candidate> teams =
          List.of(new Discussions.Candidate(PARAS, "dev"), new Discussions.Candidate(VINAYAK, "devops"));

      assertEquals(Set.of(VINAYAK), Discussions.mentionedIn("@devops please load it", teams));
    }

    @Test
    @DisplayName("several people in one comment are all found")
    void several() {
      assertEquals(
          Set.of(PARAS_M, VINAYAK),
          Discussions.mentionedIn("@paras.mahajan and @Vinayak — can we ship?", people()));
    }
  }

  @Nested
  @DisplayName("what is not a mention")
  class NotAMention {

    @Test
    @DisplayName("a name with no @ in front of it")
    void bareName() {
      assertTrue(Discussions.mentionedIn("Vinayak said it was fine", people()).isEmpty());
    }

    @Test
    @DisplayName("somebody who is not in this organisation")
    void strangerIsNotRecorded() {
      // Deliberate, and not only tidiness: resolving any @word would let somebody discover
      // whether an address belongs to this organisation by watching what highlights.
      assertTrue(Discussions.mentionedIn("@someone.else please look", people()).isEmpty());
    }

    @Test
    @DisplayName("an empty comment, or nobody to match against")
    void nothingToMatch() {
      assertTrue(Discussions.mentionedIn("", people()).isEmpty());
      assertTrue(Discussions.mentionedIn("@Vinayak", List.of()).isEmpty());
    }

    @Test
    @DisplayName("an email address written in full is not a mention of its local part")
    void plainEmailIsNotAMention() {
      // "write to paras@azalio.io" contains "@azalio" and not "@paras" — the @ is in the wrong
      // place, which is exactly what distinguishes an address from a mention.
      assertTrue(Discussions.mentionedIn("write to paras@azalio.io", people()).isEmpty());
    }
  }
}
