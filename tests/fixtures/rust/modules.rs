mod service;

mod repository {
    pub struct InMemoryRepository;

    impl InMemoryRepository {
        pub fn new() -> Self {
            InMemoryRepository
        }
    }
}

pub const MAX_RETRIES: u32 = 3;
static COUNTER: u32 = 0;
type OrderId = u32;
