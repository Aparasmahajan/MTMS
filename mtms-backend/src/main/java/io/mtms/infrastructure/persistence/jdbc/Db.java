package io.mtms.infrastructure.persistence.jdbc;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementCreator;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;

/**
 * A thin wrapper over {@link JdbcTemplate} that converts arguments on the way out.
 *
 * <p>It exists for one reason, and it is a reason worth stating in full because the failure it
 * prevents is invisible.
 *
 * <p>{@code JdbcTemplate}'s parameter lists are {@code Object...}. Passing a {@link
 * java.util.UUID} therefore compiles anywhere, and no test that uses the in-memory repositories
 * will ever notice. Connector/J does not recognise {@code UUID}, does not reject it either, and
 * falls back to <em>Java serialisation</em> — writing the bytes {@code AC ED 00 05 73 72 ...}
 * into the column. Against a {@code CHAR(36)} id that happens to raise "Incorrect string value";
 * against anything wider it would store rubbish silently and be found weeks later.
 *
 * <p>Doing the conversion at each of the hundred-odd call sites would work until somebody added
 * the hundred-and-first. Doing it here means a new query cannot get it wrong: there is no
 * un-converted path to reach.
 *
 * <p>{@link #raw()} is the escape hatch for the two shapes that carry no arguments to convert —
 * a {@code PreparedStatementCreator}, which sets its own parameters, and the one query that
 * needs a {@code RowCallbackHandler}.
 */
final class Db {

  private final JdbcTemplate jdbc;

  Db(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
    return jdbc.query(sql, mapper, Sql.args(args));
  }

  void query(String sql, RowCallbackHandler handler, Object... args) {
    jdbc.query(sql, handler, Sql.args(args));
  }

  <T> T queryForObject(String sql, Class<T> type, Object... args) {
    return jdbc.queryForObject(sql, type, Sql.args(args));
  }

  int update(String sql, Object... args) {
    return jdbc.update(sql, Sql.args(args));
  }

  /** For statements that bind their own parameters — nothing here to convert. */
  int update(PreparedStatementCreator creator) {
    return jdbc.update(creator);
  }

  JdbcTemplate raw() {
    return jdbc;
  }
}
