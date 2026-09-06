package io.mtms.application.port;

import io.mtms.domain.model.Defects;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Defects. A reference to a ticket, never a copy of one. */
public interface DefectRepository {

  List<Defects.Defect> findAll(UUID projectId);

  Optional<Defects.Defect> find(UUID projectId, UUID defectId);

  void insert(Defects.Defect defect);

  void update(Defects.Defect defect);

  void delete(UUID defectId);
}
