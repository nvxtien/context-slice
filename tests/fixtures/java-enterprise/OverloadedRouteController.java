package com.example.pets;

import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/pets")
public class OverloadedRouteController {
    private final PetService petService;

    public OverloadedRouteController(PetService petService) {
        this.petService = petService;
    }

    @PutMapping("/{id}")
    public void update(Long id) {
        petService.rename(id);
    }

    @PutMapping("/{id}/vaccinate")
    public void update(Long id, boolean vaccinate) {
        petService.vaccinate(id, vaccinate);
    }
}
