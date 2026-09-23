pub mod postgres;

pub trait OrderRepository {
    fn save(&self);
}

pub struct RepositoryError;

pub use self::postgres::PostgresRepository;
