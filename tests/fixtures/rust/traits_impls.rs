pub trait Repository {
    fn save(&self, order: &Order) -> Result<(), Error>;
    fn find(&self, id: u32) -> Option<Order> {
        None
    }
}

pub struct PostgresRepository;

impl PostgresRepository {
    pub fn new() -> Self {
        PostgresRepository
    }

    fn connect(&self) {}
}

impl Repository for PostgresRepository {
    fn save(&self, order: &Order) -> Result<(), Error> {
        Ok(())
    }
}
