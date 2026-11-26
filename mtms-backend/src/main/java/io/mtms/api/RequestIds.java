package io.mtms.api;

import io.mtms.application.ServiceException;
import java.util.UUID;

/**
 * Reads an id out of a request body.
 *
 * <p>{@code UUID.fromString} on a missing or malformed field throws a NullPointerException or an
 * IllegalArgumentException, and both reached the catch-all handler as a 500 — "something went
 * wrong on our side" — for what is plainly a bad request. This names the field instead.
 */
final class RequestIds {

  private RequestIds() {}

  static UUID uuid(String value, String field) {
    if (value == null || value.isBlank()) {
      throw ServiceException.validation(field + " is required.");
    }
    try {
      return UUID.fromString(value.trim());
    } catch (IllegalArgumentException malformed) {
      throw ServiceException.validation(field + " is not a valid id.");
    }
  }

  /** The same, for a field that may be left out. */
  static UUID optionalUuid(String value, String field) {
    return value == null || value.isBlank() ? null : uuid(value, field);
  }
}
