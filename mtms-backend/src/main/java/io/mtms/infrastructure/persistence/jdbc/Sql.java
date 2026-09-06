package io.mtms.infrastructure.persistence.jdbc;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The small conversions every row mapper needs.
 *
 * <p>Four of Postgres's types do not map to Java by default, and each has a way of going
 * wrong quietly:
 *
 * <ul>
 *   <li>{@code timestamptz} → {@link Instant}. Read via {@code getTimestamp} and converted,
 *       never {@code getObject(..., LocalDateTime.class)} — that silently drops the offset and
 *       every audit entry starts lying by however many hours the server is from UTC.
 *   <li>{@code uuid} → {@link UUID}, with null preserved. A nullable foreign key that comes
 *       back as a zero UUID is worse than one that comes back null.
 *   <li>{@code text[]} → {@link List}. Postgres arrays arrive as {@link Array}, and the JDBC
 *       driver will not guess.
 *   <li>{@code jsonb} → whatever it was. Serialised with the application's own
 *       {@link ObjectMapper} so the shape matches what the rest of the service produces.
 * </ul>
 */
final class Sql {

  private Sql() {}

  static UUID uuid(ResultSet rs, String column) throws SQLException {
    String value = rs.getString(column);
    return value == null ? null : UUID.fromString(value);
  }

  /** Null-preserving. A null timestamp means "has not happened", which is never `epoch`. */
  static Instant instant(ResultSet rs, String column) throws SQLException {
    Timestamp value = rs.getTimestamp(column);
    return value == null ? null : value.toInstant();
  }

  static LocalDate date(ResultSet rs, String column) throws SQLException {
    java.sql.Date value = rs.getDate(column);
    return value == null ? null : value.toLocalDate();
  }

  static Timestamp timestamp(Instant instant) {
    return instant == null ? null : Timestamp.from(instant);
  }

  static java.sql.Date date(LocalDate date) {
    return date == null ? null : java.sql.Date.valueOf(date);
  }

  static List<String> textArray(ResultSet rs, String column) throws SQLException {
    Array array = rs.getArray(column);
    if (array == null) {
      return List.of();
    }
    try {
      String[] values = (String[]) array.getArray();
      return values == null ? List.of() : List.of(values);
    } finally {
      // Postgres holds a server-side resource for the array; not freeing it leaks until the
      // connection is returned, which under a pool means it is not returned at all.
      array.free();
    }
  }

  static String[] toArray(List<String> values) {
    return values == null ? new String[0] : values.toArray(new String[0]);
  }

  static String json(ObjectMapper mapper, Object value) {
    try {
      return mapper.writeValueAsString(value == null ? Map.of() : value);
    } catch (Exception e) {
      throw new IllegalStateException("Could not serialise a jsonb column", e);
    }
  }

  static <T> T fromJson(ObjectMapper mapper, ResultSet rs, String column, TypeReference<T> type)
      throws SQLException {
    String raw = rs.getString(column);
    if (raw == null || raw.isBlank()) {
      return null;
    }
    try {
      return mapper.readValue(raw, type);
    } catch (Exception e) {
      throw new IllegalStateException("Could not read the jsonb column " + column, e);
    }
  }

  /** Never null. The empty string is the stored form of "nothing recorded". */
  static String status(ResultSet rs, String column) throws SQLException {
    String value = rs.getString(column);
    return value == null ? "" : value;
  }
}
